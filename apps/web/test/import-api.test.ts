import { exports } from 'cloudflare:workers'
import {
  DEFAULT_LIST_TITLE,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LISTS_PER_USER_MAX,
} from '@yaritai100list/shared'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * localStorage からの取り込み API のテスト（#90）。
 *
 * 規則は `PRODUCT_SPEC.md` §2「ログイン時の引き継ぎ」。
 * **勝手に上限を超えさせない／勝手に捨てない**が要点なので、
 * 「取り込まれないこと」と「既存が書き換わらないこと」を厚めに固定する。
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

function importList(headers: Headers, body: unknown) {
  return request('/api/lists/import', {
    method: 'POST',
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** そのリストの項目を並び順で読む。 */
async function textsOf(listId: string) {
  const rows = await testDb()
    .select()
    .from(items)
    .where(eq(items.listId, listId))
    .orderBy(asc(items.position))

  return rows.map((row) => row.text)
}

describe('POST /api/lists/import', () => {
  it('🔴 未ログインでは取り込めない', async () => {
    const res = await importList(new Headers(), { items: [{ text: '南極に行く' }] })

    expect(res.status).toBe(401)
    expect(await testDb().select().from(lists)).toEqual([])
  })

  it('リストと項目が作られ、並び順が保たれる', async () => {
    const me = await signIn('importer@example.com')

    const res = await importList(me.headers, {
      title: '2026年の目標',
      items: [{ text: '1つ目' }, { text: '2つ目' }, { text: '3つ目' }],
    })

    expect(res.status).toBe(201)

    const body = await res.json<{ list: { id: string; title: string } }>()
    expect(body.list.title).toBe('2026年の目標')
    expect(await textsOf(body.list.id)).toEqual(['1つ目', '2つ目', '3つ目'])
  })

  it('タイトルを省略すると既定のタイトルになる', async () => {
    const me = await signIn('notitle@example.com')

    await importList(me.headers, { items: [{ text: 'x' }] })

    const [row] = await testDb().select().from(lists)
    expect(row?.title).toBe(DEFAULT_LIST_TITLE)
  })

  it('取り込んだ項目は未完了で始まる', async () => {
    const me = await signIn('fresh@example.com')

    await importList(me.headers, { items: [{ text: 'x' }] })

    const [row] = await testDb().select().from(items)
    expect(row?.completedAt).toBeNull()
  })

  it('🔴 完了の状態を送り込めない（未ログインでは印を付けられないため）', async () => {
    const me = await signIn('completed@example.com')

    // 受け取る口を作ると、#77 の制約を要求の組み立てだけで迂回できてしまう
    const res = await importList(me.headers, {
      items: [{ text: 'x', completedAt: 1_700_000_000_000 }],
    })

    expect(res.status).toBe(400)
    expect(await testDb().select().from(lists)).toEqual([])
  })

  it('🔴 空のリストは取り込まれない', async () => {
    const me = await signIn('empty@example.com')

    const res = await importList(me.headers, { items: [] })

    expect(res.status).toBe(400)
    expect(await testDb().select().from(lists)).toEqual([])
  })

  it('100件ちょうどを取り込める（D1 のバインド変数の上限を越えない）', async () => {
    const me = await signIn('full@example.com')

    // 1文で入れると too many SQL variables で落ちる。分割していることの確認（#89）
    const res = await importList(me.headers, {
      items: Array.from({ length: ITEMS_PER_LIST_MAX }, (_, i) => ({
        text: `やりたい${String(i)}`,
      })),
    })

    expect(res.status).toBe(201)

    const [row] = await testDb().select().from(lists)
    expect(await textsOf(row?.id ?? '')).toHaveLength(ITEMS_PER_LIST_MAX)
  })

  it('上限を超える件数は拒否する', async () => {
    const me = await signIn('over@example.com')

    const res = await importList(me.headers, {
      items: Array.from({ length: ITEMS_PER_LIST_MAX + 1 }, () => ({ text: 'x' })),
    })

    expect(res.status).toBe(400)
    expect(await testDb().select().from(lists)).toEqual([])
  })

  it('上限を超える本文は拒否する', async () => {
    const me = await signIn('long@example.com')

    const res = await importList(me.headers, {
      items: [{ text: 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1) }],
    })

    expect(res.status).toBe(400)
    // 1件でも通らなければ、リストも作らない
    expect(await testDb().select().from(lists)).toEqual([])
  })

  describe('すでにリストを持っている場合', () => {
    it('🔴 既存のリストにマージせず、新しいリストとして足す', async () => {
      const me = await signIn('has-list@example.com')
      const db = testDb()

      await db.insert(lists).values({ id: 'existing', userId: me.userId, title: '既存' })
      await db
        .insert(items)
        .values({ id: 'kept', listId: 'existing', text: '既存の項目', position: 0 })

      await importList(me.headers, { items: [{ text: '取り込んだ項目' }] })

      // 意図しない混ざりを防ぐ（PRODUCT_SPEC.md §2）
      expect(await textsOf('existing')).toEqual(['既存の項目'])
      expect(await db.select().from(lists)).toHaveLength(2)
    })

    it('🔴 上限に達していたら取り込まない', async () => {
      const me = await signIn('limit@example.com')
      const db = testDb()

      await db.insert(lists).values(
        Array.from({ length: LISTS_PER_USER_MAX }, (_, i) => ({
          id: `list-${String(i)}`,
          userId: me.userId,
          title: 'x',
        })),
      )

      const res = await importList(me.headers, { items: [{ text: '取り込めない' }] })

      // 勝手に上限を超えさせない。ブラウザ側を消さずに残せるよう理由を返す
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'List Limit Reached' })
      expect(await db.select().from(lists)).toHaveLength(LISTS_PER_USER_MAX)
      expect(await db.select().from(items)).toEqual([])
    })

    it('🔴 他人が上限まで持っていても、自分は取り込める', async () => {
      const other = await signIn('other@example.com')
      const db = testDb()

      await db.insert(lists).values(
        Array.from({ length: LISTS_PER_USER_MAX }, (_, i) => ({
          id: `other-${String(i)}`,
          userId: other.userId,
          title: 'x',
        })),
      )

      const me = await signIn('me@example.com')

      expect((await importList(me.headers, { items: [{ text: 'x' }] })).status).toBe(201)
    })
  })

  it('🔴 知らないキーは拒否する', async () => {
    const me = await signIn('extra@example.com')

    // userId や visibility を送り込む経路を塞ぐ
    const res = await importList(me.headers, {
      userId: 'someone-else',
      items: [{ text: 'x' }],
    })

    expect(res.status).toBe(400)
    expect(await testDb().select().from(lists)).toEqual([])
  })
})
