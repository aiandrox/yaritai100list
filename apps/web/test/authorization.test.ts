import { exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { signOutRequestInit } from '../src/client/model'
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

describe('ログアウト', () => {
  /**
   * ブラウザが送る形に合わせる。
   *
   * - **Origin が無いと Better Auth の CSRF 保護に弾かれる**
   *   （Cookie を伴う POST で Origin を検証している）
   * - **要求の中身は画面側と同じ `signOutRequestInit()` を使う。**
   *   ここに直接書くと、画面側だけ直したときにテストが気づけない
   */
  const signOutRequest = (headers: Headers) => {
    const init = signOutRequestInit()

    return request('/api/auth/sign-out', {
      ...init,
      headers: { ...init.headers, ...Object.fromEntries(headers), origin: testBaseUrl() },
    })
  }

  it('セッションが D1 から消える', async () => {
    const me = await signIn('signout@example.com')

    expect(await testDb().select().from(sessions)).toHaveLength(1)

    const res = await signOutRequest(me.headers)

    expect(res.status).toBe(200)
    // Cookie を消すだけでなく、**サーバー側の行が消えること**を確認する。
    // 行が残っていると、Cookie を持っている誰かが使い続けられる
    expect(await testDb().select().from(sessions)).toHaveLength(0)
  })

  it('ログアウト後は保護 API が通らない', async () => {
    const me = await signIn('signout2@example.com')

    await signOutRequest(me.headers)

    expect((await request('/api/lists', { headers: me.headers })).status).toBe(401)
  })

  it('Origin の無いログアウト要求は拒否される（CSRF 保護）', async () => {
    const me = await signIn('csrf@example.com')

    const res = await request('/api/auth/sign-out', { method: 'POST', headers: me.headers })

    expect(res.status).toBe(403)
    // 拒否されたのだからセッションは残っている
    expect(await testDb().select().from(sessions)).toHaveLength(1)
  })

  it('🔴 本文があって content-type が無いと 415（本番で踏んだ）', async () => {
    // ブラウザの `fetch(url, { method: 'POST' })` は本文が無くても Content-Length: 0 を
    // 送るため、Workers 側では「本文あり」に見えて better-call の 415 に落ちる。
    // **`new Request` は body が null なのでこの経路を再現しない。**
    // 明示的に本文を付けて、415 になること自体を固定する（画面側が content-type を
    // 落としたら、この仕様のせいで壊れると分かるように）
    const me = await signIn('media-type@example.com')

    // 本文をバイト列で渡す。**文字列を渡すと `Request` が
    // `content-type: text/plain` を勝手に付けてしまい、「無い」状態を作れない**
    const res = await request('/api/auth/sign-out', {
      method: 'POST',
      headers: { ...Object.fromEntries(me.headers), origin: testBaseUrl() },
      body: new TextEncoder().encode('{}'),
    })

    expect(res.status).toBe(415)
    expect(await testDb().select().from(sessions)).toHaveLength(1)
  })
})
