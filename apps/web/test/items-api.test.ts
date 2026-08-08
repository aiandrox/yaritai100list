import { exports } from 'cloudflare:workers'
import { ITEM_TEXT_MAX_LENGTH, ITEMS_PER_LIST_MAX } from '@yaritai100list/shared'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 項目の API のテスト（#89）。
 *
 * 認可は「通らないこと」を書く（`docs/workflow.md` §6）。
 * **自分のリストの URL に他人の項目 ID を混ぜる**経路も見る。
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

function json(headers: Headers, method: string, body: unknown) {
  return {
    method,
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** 自分と他人、それぞれのリストを用意する。 */
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

/** 項目を1件足して、その id を返す。 */
async function addItem(headers: Headers, listId: string, text: string): Promise<string> {
  const res = await request(`/api/lists/${listId}/items`, json(headers, 'POST', { text }))
  const { item } = await res.json<{ item: { id: string } }>()

  return item.id
}

/** そのリストの項目を並び順で読む。 */
async function positionsOf(listId: string) {
  const rows = await testDb()
    .select()
    .from(items)
    .where(eq(items.listId, listId))
    .orderBy(asc(items.position))

  return rows.map((row) => `${String(row.position)}:${row.text}`)
}

describe('項目の作成', () => {
  it('末尾に足される。完了日時は入っていない', async () => {
    const { me } = await twoUsers()

    await addItem(me.headers, 'my-list', '南極に行く')
    await addItem(me.headers, 'my-list', 'オーロラを見る')

    expect(await positionsOf('my-list')).toEqual(['0:南極に行く', '1:オーロラを見る'])

    const [first] = await testDb().select().from(items).where(eq(items.position, 0))
    expect(first?.completedAt).toBeNull()
  })

  it('リストの更新日時が新しくなる（最後に更新したリストを出すため）', async () => {
    const { me } = await twoUsers()
    const before = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))

    await addItem(me.headers, 'my-list', '南極に行く')

    const [after] = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before[0]?.updatedAt.getTime() ?? Infinity,
    )
  })

  it('🔴 未ログインでは足せない', async () => {
    await twoUsers()

    const res = await request(
      '/api/lists/my-list/items',
      json(new Headers(), 'POST', { text: 'x' }),
    )

    expect(res.status).toBe(401)
    expect(await testDb().select().from(items)).toEqual([])
  })

  it('🔴 他人のリストには足せない。存在しない ID と応答が一致する', async () => {
    const { me } = await twoUsers()

    const others = await request(
      '/api/lists/other-list/items',
      json(me.headers, 'POST', { text: 'x' }),
    )
    const missing = await request(
      '/api/lists/no-such/items',
      json(me.headers, 'POST', { text: 'x' }),
    )

    expect(others.status).toBe(404)
    expect(await others.text()).toBe(await missing.text())
    expect(await testDb().select().from(items)).toEqual([])
  })

  it('🔴 上限を超えて足せない', async () => {
    const { me } = await twoUsers()

    const rows = Array.from({ length: ITEMS_PER_LIST_MAX }, (_, i) => ({
      id: `item-${String(i)}`,
      listId: 'my-list',
      text: 'x',
      position: i,
    }))

    // ⚠️ 100件を1文で insert すると **D1 が「too many SQL variables」で落ちる**
    // （SQLite のバインド変数の上限。1行4列なので25行ずつに割る）。
    // 取り込み API（#90）でも同じ制限を踏むので、あちらでも分ける必要がある
    for (let i = 0; i < rows.length; i += 20) {
      await testDb()
        .insert(items)
        .values(rows.slice(i, i + 20))
    }

    const res = await request(
      '/api/lists/my-list/items',
      json(me.headers, 'POST', { text: 'over' }),
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Item Limit Reached' })
    expect(await testDb().select().from(items)).toHaveLength(ITEMS_PER_LIST_MAX)
  })

  it('上限を超える本文は拒否する', async () => {
    const { me } = await twoUsers()

    const res = await request(
      '/api/lists/my-list/items',
      json(me.headers, 'POST', { text: 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1) }),
    )

    expect(res.status).toBe(400)
    expect(await testDb().select().from(items)).toEqual([])
  })

  it('🔴 並び順を指定して割り込めない', async () => {
    const { me } = await twoUsers()

    const res = await request(
      '/api/lists/my-list/items',
      json(me.headers, 'POST', { text: 'x', position: 0 }),
    )

    expect(res.status).toBe(400)
  })
})

describe('項目の変更', () => {
  it('本文を変えられる', async () => {
    const { me } = await twoUsers()
    const id = await addItem(me.headers, 'my-list', '南極に行く')

    const res = await request(
      `/api/lists/my-list/items/${id}`,
      json(me.headers, 'PATCH', { text: '北極に行く' }),
    )

    expect(res.status).toBe(200)

    const [row] = await testDb().select().from(items).where(eq(items.id, id))
    expect(row?.text).toBe('北極に行く')
  })

  it('完了にすると日時が入り、取り消すと消える', async () => {
    const { me } = await twoUsers()
    const id = await addItem(me.headers, 'my-list', '南極に行く')

    await request(`/api/lists/my-list/items/${id}`, json(me.headers, 'PATCH', { completed: true }))
    const [done] = await testDb().select().from(items).where(eq(items.id, id))
    expect(done?.completedAt).toBeInstanceOf(Date)

    await request(`/api/lists/my-list/items/${id}`, json(me.headers, 'PATCH', { completed: false }))
    const [undone] = await testDb().select().from(items).where(eq(items.id, id))
    expect(undone?.completedAt).toBeNull()
  })

  it('🔴 完了日時を送り込めない（時刻はサーバーが決める）', async () => {
    const { me } = await twoUsers()
    const id = await addItem(me.headers, 'my-list', '南極に行く')

    // 端末の時計は狂っていることがある。「未来に叶えたこと」にさせない
    const res = await request(
      `/api/lists/my-list/items/${id}`,
      json(me.headers, 'PATCH', { completedAt: 4_102_444_800_000 }),
    )

    expect(res.status).toBe(400)
  })

  it('🔴 完了しても並び順が変わらない', async () => {
    const { me } = await twoUsers()
    await addItem(me.headers, 'my-list', '1つ目')
    const second = await addItem(me.headers, 'my-list', '2つ目')
    await addItem(me.headers, 'my-list', '3つ目')

    await request(
      `/api/lists/my-list/items/${second}`,
      json(me.headers, 'PATCH', { completed: true }),
    )

    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:2つ目', '2:3つ目'])
  })

  it('空の本文は拒否する（黙って何もしない応答を返さない）', async () => {
    const { me } = await twoUsers()
    const id = await addItem(me.headers, 'my-list', '南極に行く')

    const res = await request(`/api/lists/my-list/items/${id}`, json(me.headers, 'PATCH', {}))

    expect(res.status).toBe(400)
  })

  it('🔴 他人のリストの項目は変えられない', async () => {
    const { me, other } = await twoUsers()
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request(
      `/api/lists/other-list/items/${theirs}`,
      json(me.headers, 'PATCH', { text: '乗っ取り' }),
    )

    expect(res.status).toBe(404)

    const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
    expect(row?.text).toBe('他人の項目')
  })

  it('🔴 自分のリストの URL に他人の項目 ID を混ぜても変えられない', async () => {
    const { me, other } = await twoUsers()
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    // リストの所有者チェックは通るので、項目とリストの紐付けを見ないと通ってしまう
    const res = await request(
      `/api/lists/my-list/items/${theirs}`,
      json(me.headers, 'PATCH', { text: '乗っ取り' }),
    )

    expect(res.status).toBe(404)

    const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
    expect(row?.text).toBe('他人の項目')
  })
})

describe('項目の削除', () => {
  it('🔴 消すと後ろの並び順が詰まる', async () => {
    const { me } = await twoUsers()
    await addItem(me.headers, 'my-list', '1つ目')
    const second = await addItem(me.headers, 'my-list', '2つ目')
    await addItem(me.headers, 'my-list', '3つ目')

    await request(`/api/lists/my-list/items/${second}`, {
      method: 'DELETE',
      headers: me.headers,
    })

    // 穴が空くと「0から始まる詰まった連番」という前提が崩れる（TECH_STACK.md §7）
    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:3つ目'])
  })

  it('🔴 他人の項目は消せない', async () => {
    const { me, other } = await twoUsers()
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request(`/api/lists/my-list/items/${theirs}`, {
      method: 'DELETE',
      headers: me.headers,
    })

    expect(res.status).toBe(404)
    expect(await testDb().select().from(items).where(eq(items.id, theirs))).toHaveLength(1)
  })
})

describe('並び替え', () => {
  it('送った順に並び直る', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    const b = await addItem(me.headers, 'my-list', '2つ目')
    const c = await addItem(me.headers, 'my-list', '3つ目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [c, a, b] }),
    )

    expect(res.status).toBe(200)
    expect(await positionsOf('my-list')).toEqual(['0:3つ目', '1:1つ目', '2:2つ目'])
  })

  it('🔴 項目が欠けている並びは拒否する', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    await addItem(me.headers, 'my-list', '2つ目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [a] }),
    )

    expect(res.status).toBe(409)
    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:2つ目'])
  })

  it('🔴 他人の項目 ID を混ぜて引き込めない', async () => {
    const { me, other } = await twoUsers()
    const mine = await addItem(me.headers, 'my-list', '自分の項目')
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [theirs, mine] }),
    )

    expect(res.status).toBe(409)

    const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
    expect(row?.listId).toBe('other-list')
  })

  it('🔴 同じ ID を並べて数を合わせられない', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    await addItem(me.headers, 'my-list', '2つ目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [a, a] }),
    )

    expect(res.status).toBe(409)
    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:2つ目'])
  })
})

describe('書き込みを減らす（#142）', () => {
  it('位置が変わっていない項目は書き直さない', async () => {
    // 隣と入れ替えるだけで100行書くと、D1 の 10万行/日 をすぐ使う（TECH_STACK.md §13）
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    const b = await addItem(me.headers, 'my-list', '2つ目')
    const c = await addItem(me.headers, 'my-list', '3つ目')

    const before = await testDb().select().from(items).where(eq(items.id, c))

    // 先頭2つだけ入れ替える。3つ目は位置が変わらない
    await request('/api/lists/my-list/items/order', json(me.headers, 'PUT', { itemIds: [b, a, c] }))

    const [after] = await testDb().select().from(items).where(eq(items.id, c))

    expect(await positionsOf('my-list')).toEqual(['0:2つ目', '1:1つ目', '2:3つ目'])
    // 触っていない項目は updated_at も動かない
    expect(after?.updatedAt.getTime()).toBe(before[0]?.updatedAt.getTime())
  })
})

describe('リストの取得', () => {
  it('リストと項目を並び順で返す', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    const b = await addItem(me.headers, 'my-list', '2つ目')
    await request('/api/lists/my-list/items/order', json(me.headers, 'PUT', { itemIds: [b, a] }))

    const res = await request('/api/lists/my-list', { headers: me.headers })
    const body = await res.json<{ list: { id: string }; items: { id: string }[] }>()

    expect(body.list.id).toBe('my-list')
    expect(body.items.map((item) => item.id)).toEqual([b, a])
  })

  it('🔴 他人のリストの項目は読めない', async () => {
    const { me, other } = await twoUsers()
    await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request('/api/lists/other-list', { headers: me.headers })

    expect(res.status).toBe(404)
  })

  it('リストを消すと項目も消える', async () => {
    const { me } = await twoUsers()
    await addItem(me.headers, 'my-list', '1つ目')

    await request('/api/lists/my-list', { method: 'DELETE', headers: me.headers })

    expect(await testDb().select().from(items)).toEqual([])
  })
})
