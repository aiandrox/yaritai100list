import { exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { lists, sessions } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 認可のテスト。**「通らないこと」を書く。**
 *
 * `docs/workflow.md` §6 の通り、成功パスだけでは意味がない。
 * 他人のリストに触れないこと、失効したセッションが通らないことを固定する。
 */

// オリジンは Worker の BETTER_AUTH_URL に揃える（Cookie 名と Origin チェックのため）
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

/** 自分と他人、それぞれのリストを用意する */
async function twoUsers() {
  const me = await signIn('me@example.com')
  const other = await signIn('other@example.com')

  await testDb()
    .insert(lists)
    .values([
      { id: 'my-list', userId: me.userId, title: '自分のリスト' },
      { id: 'other-list', userId: other.userId, title: '他人のリスト' },
    ])

  return { me, other }
}

describe('未ログイン', () => {
  it('リストの一覧を取れない', async () => {
    const res = await request('/api/lists')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('リスト1件を取れない', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists/my-list')

    expect(res.status).toBe(401)
    // 存在は漏らさない
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(me.userId).toBeTruthy()
  })

  it('リストを更新できない', async () => {
    await twoUsers()

    const res = await request('/api/lists/my-list', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '書き換え' }),
    })

    expect(res.status).toBe(401)

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))
    expect(row?.title).toBe('自分のリスト')
  })

  it('リストを削除できない', async () => {
    await twoUsers()

    const res = await request('/api/lists/my-list', { method: 'DELETE' })

    expect(res.status).toBe(401)
    expect(await testDb().select().from(lists).where(eq(lists.id, 'my-list'))).toHaveLength(1)
  })
})

describe('ログイン中', () => {
  it('自分のリストは取れる', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists/my-list', { headers: me.headers })

    expect(res.status).toBe(200)
  })

  it('一覧に他人のリストが混ざらない', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists', { headers: me.headers })
    const body = await res.json<{ lists: { id: string }[] }>()

    expect(body.lists.map((l) => l.id)).toEqual(['my-list'])
  })

  it('他人のリストは読めない', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists/other-list', { headers: me.headers })

    expect(res.status).toBe(404)
  })

  it('他人のリストには書けない', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists/other-list', {
      method: 'PATCH',
      headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
      body: JSON.stringify({ title: '乗っ取り' }),
    })

    expect(res.status).toBe(404)

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'other-list'))
    expect(row?.title).toBe('他人のリスト')
  })

  it('他人のリストは削除できない', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists/other-list', { method: 'DELETE', headers: me.headers })

    expect(res.status).toBe(404)
    expect(await testDb().select().from(lists).where(eq(lists.id, 'other-list'))).toHaveLength(1)
  })

  it('🔴 存在しない ID と他人の ID で応答が完全に一致する', async () => {
    const { me } = await twoUsers()

    const missing = await request('/api/lists/no-such-list', { headers: me.headers })
    const others = await request('/api/lists/other-list', { headers: me.headers })

    // 404 と 403 を出し分けると「その ID は存在する」と分かってしまい、
    // 推測不可能な ID にしている意味が薄れる
    expect(missing.status).toBe(others.status)
    expect(await missing.text()).toBe(await others.text())
  })
})

describe('失効したセッション', () => {
  it('セッションの行を消すと通らなくなる', async () => {
    const { me } = await twoUsers()

    // 消す前は通る
    expect((await request('/api/lists', { headers: me.headers })).status).toBe(200)

    // サーバー側から失効させる
    await testDb().delete(sessions)

    expect((await request('/api/lists', { headers: me.headers })).status).toBe(401)
  })
})

describe('入力の検証', () => {
  it('上限を超えるタイトルは拒否する', async () => {
    const me = await signIn('validator@example.com')
    await testDb().insert(lists).values({ id: 'v-list', userId: me.userId, title: 'x' })

    const res = await request('/api/lists/v-list', {
      method: 'PATCH',
      headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
      // リストタイトルの上限は 15 文字（packages/shared）
      body: JSON.stringify({ title: 'あ'.repeat(16) }),
    })

    expect(res.status).toBe(400)

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'v-list'))
    expect(row?.title).toBe('x')
  })

  it('知らないキーは拒否する', async () => {
    const me = await signIn('validator2@example.com')
    await testDb().insert(lists).values({ id: 'v2-list', userId: me.userId, title: 'x' })

    // user_id を書き換えて他人に付け替える、といった経路を塞ぐ
    const res = await request('/api/lists/v2-list', {
      method: 'PATCH',
      headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'someone-else' }),
    })

    expect(res.status).toBe(400)
  })
})
