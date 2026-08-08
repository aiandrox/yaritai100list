import { exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 公開設定と共有リンクの再発行のテスト（#136）。
 *
 * **他人のリストの公開範囲を変えられないこと**が要。
 * 公開は「うっかり」では起きてはいけない（`PRODUCT_SPEC.md` §5.1）。
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

function patch(headers: Headers, listId: string, body: unknown) {
  return request(`/api/lists/${listId}`, {
    method: 'PATCH',
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

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

async function shareIdOf(listId: string) {
  const [row] = await testDb().select().from(lists).where(eq(lists.id, listId))

  return row?.shareId
}

describe('公開範囲を変える', () => {
  it('リンク限定公開にできる', async () => {
    const { me } = await twoUsers()

    const res = await patch(me.headers, 'my-list', { visibility: 'unlisted' })

    expect(res.status).toBe(200)

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))
    expect(row?.visibility).toBe('unlisted')
  })

  it('非公開に戻せる', async () => {
    const { me } = await twoUsers()

    await patch(me.headers, 'my-list', { visibility: 'public' })
    await patch(me.headers, 'my-list', { visibility: 'private' })

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))
    expect(row?.visibility).toBe('private')
  })

  it('🔴 未ログインでは変えられない', async () => {
    await twoUsers()

    const res = await request('/api/lists/my-list', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    })

    expect(res.status).toBe(401)

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))
    expect(row?.visibility).toBe('private')
  })

  it('🔴 他人のリストを公開にできない', async () => {
    const { me } = await twoUsers()

    const res = await patch(me.headers, 'other-list', { visibility: 'public' })

    expect(res.status).toBe(404)

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'other-list'))
    expect(row?.visibility).toBe('private')
  })

  it('知らない公開範囲は拒否する', async () => {
    const { me } = await twoUsers()

    const res = await patch(me.headers, 'my-list', { visibility: 'everyone' })

    expect(res.status).toBe(400)
  })

  it('🔴 公開範囲を変えても share_id は変わらない', async () => {
    // 変わると、公開した瞬間に渡してあったリンクが死ぬ。
    // リンクを切りたいのは別の操作（再発行）
    const { me } = await twoUsers()
    const before = await shareIdOf('my-list')

    await patch(me.headers, 'my-list', { visibility: 'unlisted' })

    expect(await shareIdOf('my-list')).toBe(before)
  })
})

describe('共有リンクの再発行', () => {
  const regenerate = (headers: Headers, listId: string) =>
    request(`/api/lists/${listId}/share-id`, { method: 'POST', headers })

  it('値が変わる', async () => {
    const { me } = await twoUsers()
    const before = await shareIdOf('my-list')

    const res = await regenerate(me.headers, 'my-list')

    expect(res.status).toBe(200)

    const after = await shareIdOf('my-list')
    expect(after).not.toBe(before)
    expect(after?.length).toBe(32)
  })

  it('公開範囲は変わらない', async () => {
    const { me } = await twoUsers()
    await patch(me.headers, 'my-list', { visibility: 'unlisted' })

    await regenerate(me.headers, 'my-list')

    const [row] = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))
    expect(row?.visibility).toBe('unlisted')
  })

  it('🔴 未ログインでは再発行できない', async () => {
    await twoUsers()
    const before = await shareIdOf('my-list')

    const res = await request('/api/lists/my-list/share-id', { method: 'POST' })

    expect(res.status).toBe(401)
    expect(await shareIdOf('my-list')).toBe(before)
  })

  it('🔴 他人のリストは再発行できない。存在しない ID と応答が一致する', async () => {
    const { me } = await twoUsers()
    const before = await shareIdOf('other-list')

    const others = await regenerate(me.headers, 'other-list')
    const missing = await regenerate(me.headers, 'no-such-list')

    expect(others.status).toBe(404)
    expect(await others.text()).toBe(await missing.text())
    expect(await shareIdOf('other-list')).toBe(before)
  })
})

describe('自分のリストの共有 URL を組み立てるのに必要な情報', () => {
  it('一覧に share_id が入っている', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists', { headers: me.headers })
    const body = await res.json<{ lists: { id: string; shareId: string }[] }>()

    expect(body.lists[0]?.shareId).toBe(await shareIdOf('my-list'))
  })

  it('🔴 一覧に他人のリストは入らない（share_id ごと漏らさない）', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists', { headers: me.headers })
    const body = await res.json<{ lists: { id: string }[] }>()

    expect(body.lists.map((list) => list.id)).toEqual(['my-list'])
  })
})
