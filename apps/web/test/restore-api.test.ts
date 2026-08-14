import { exports } from 'cloudflare:workers'
import {
  EXPORT_VERSION,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LISTS_PER_USER_MAX,
  hasFutureCompletedAt,
  isFutureCompletedAt,
} from '@yaritai100list/shared'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 書き出したファイルの読み込みのテスト（#122）。
 *
 * **`POST /api/lists/import`（localStorage からの引き継ぎ）とは別の経路。**
 * あちらが完了日時を受け取らないこと（#77）を壊していないかも、ここで見る。
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

/** 書き出したファイルの形。既定は最小限の中身。 */
function exportFile(overrides: Record<string, unknown> = {}) {
  return {
    version: EXPORT_VERSION,
    exportedAt: '2026-08-07T12:00:00.000Z',
    list: { title: '2026年の目標', items: [{ text: '南極に行く', completedAt: null }] },
    ...overrides,
  }
}

function restore(headers: Headers, body: unknown) {
  return request('/api/lists/restore', {
    method: 'POST',
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function itemsOf(listId: string) {
  return testDb().select().from(items).where(eq(items.listId, listId)).orderBy(asc(items.position))
}

/**
 * 「どこまでを完了日時として受け取るか」の判定（#207）。
 *
 * 🔴 **読み込み（`hasFutureCompletedAt`）と完了日の直しが同じものを使う。**
 * ここが2箇所に分かれると、片方だけ緩んだときに気づけない。
 */
describe('isFutureCompletedAt', () => {
  const now = new Date('2026-08-07T12:00:00.000Z')

  it('未来は弾く', () => {
    expect(isFutureCompletedAt(new Date('2026-08-07T12:00:00.001Z'), now)).toBe(true)
  })

  it('🔴 ちょうど今は通す（境目を弾かない）', () => {
    expect(isFutureCompletedAt(now, now)).toBe(false)
  })

  it('🔴 下限は無い（去年やったことを後から書ける）', () => {
    expect(isFutureCompletedAt(new Date('1970-01-01T00:00:00.000Z'), now)).toBe(false)
  })
})

describe('hasFutureCompletedAt', () => {
  const now = new Date('2026-08-07T12:00:00.000Z')

  it('🔴 未来の完了日時を見つける', () => {
    const file = {
      version: EXPORT_VERSION as typeof EXPORT_VERSION,
      exportedAt: now.toISOString(),
      list: { title: 'x', items: [{ text: 'a', completedAt: '2099-01-01T00:00:00.000Z' }] },
    }

    expect(hasFutureCompletedAt(file, now)).toBe(true)
  })

  it('過去は通す（いつ叶えたかは持ち主のもの）', () => {
    const file = {
      version: EXPORT_VERSION as typeof EXPORT_VERSION,
      exportedAt: now.toISOString(),
      list: {
        title: 'x',
        items: [
          { text: 'a', completedAt: '1999-01-01T00:00:00.000Z' },
          { text: 'b', completedAt: null },
        ],
      },
    }

    expect(hasFutureCompletedAt(file, now)).toBe(false)
  })
})

describe('POST /api/lists/restore', () => {
  it('🔴 未ログインでは読み込めない', async () => {
    const res = await restore(new Headers(), exportFile())

    expect(res.status).toBe(401)
    expect(await testDb().select().from(lists)).toEqual([])
  })

  it('新しいリストとして作られ、完了日時が復元される', async () => {
    const me = await signIn('restorer@example.com')

    const res = await restore(
      me.headers,
      exportFile({
        list: {
          title: '2026年の目標',
          items: [
            { text: '南極に行く', completedAt: '2026-05-01T00:00:00.000Z' },
            { text: 'オーロラを見る', completedAt: null },
          ],
        },
      }),
    )

    expect(res.status).toBe(201)

    const body = await res.json<{ list: { id: string; title: string } }>()
    expect(body.list.title).toBe('2026年の目標')

    const rows = await itemsOf(body.list.id)
    expect(rows.map((row) => row.text)).toEqual(['南極に行く', 'オーロラを見る'])
    expect(rows[0]?.completedAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(rows[1]?.completedAt).toBeNull()

    // 🔴 **粒度を持たないファイル（#279 より前に書き出したもの）は day として読む。**
    // マイグレーション 0016 の補い方と同じ
    expect(rows[0]?.completedPrecision).toBe('day')
    expect(rows[1]?.completedPrecision).toBeNull()
  })

  /** 完了日の粒度（#279）。**日付なしの完了が往復すること** */
  describe('完了日の粒度（#279）', () => {
    it('粒度をそのまま復元する', async () => {
      const me = await signIn('precision@example.com')

      const res = await restore(
        me.headers,
        exportFile({
          list: {
            title: '2026年の目標',
            items: [
              { text: '日付なし', completedAt: null, completedPrecision: 'unknown' },
              {
                text: '年だけ',
                completedAt: '2025-12-31T15:00:00.000Z',
                completedPrecision: 'year',
              },
              {
                text: '年月だけ',
                completedAt: '2026-07-31T15:00:00.000Z',
                completedPrecision: 'month',
              },
              { text: '未完了', completedAt: null, completedPrecision: null },
            ],
          },
        }),
      )

      expect(res.status).toBe(201)

      const body = await res.json<{ list: { id: string } }>()
      const rows = await itemsOf(body.list.id)

      expect(rows.map((row) => row.completedPrecision)).toEqual(['unknown', 'year', 'month', null])
      // 日付なしの完了は日時を持たないまま入る
      expect(rows[0]?.completedAt).toBeNull()
    })

    it('🔴 粒度と完了日時が食い違うファイルは断る', async () => {
      const me = await signIn('broken-precision@example.com')

      const res = await restore(
        me.headers,
        exportFile({
          list: {
            title: 'x',
            // 手で編集したファイル。DB のトリガーまで届かせない
            items: [{ text: '壊れている', completedAt: null, completedPrecision: 'day' }],
          },
        }),
      )

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('🔴 未来の年を持つファイルは断る', async () => {
      const me = await signIn('future-year@example.com')

      const res = await restore(
        me.headers,
        exportFile({
          list: {
            title: 'x',
            items: [
              {
                text: '来年やった',
                completedAt: '2099-01-01T00:00:00.000Z',
                completedPrecision: 'year',
              },
            ],
          },
        }),
      )

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })
  })

  it('項目が0件のファイルも読み込める', async () => {
    // 書き出せる以上、読み込めないと往復が壊れる
    const me = await signIn('empty@example.com')

    const res = await restore(me.headers, exportFile({ list: { title: '空', items: [] } }))

    expect(res.status).toBe(201)
    expect(await testDb().select().from(lists)).toHaveLength(1)
  })

  it('100件ちょうどを読み込める（D1 のバインド変数の上限を越えない）', async () => {
    const me = await signIn('full@example.com')

    const res = await restore(
      me.headers,
      exportFile({
        list: {
          title: 'いっぱい',
          items: Array.from({ length: ITEMS_PER_LIST_MAX }, (_, i) => ({
            text: `やりたい${String(i)}`,
            completedAt: null,
          })),
        },
      }),
    )

    expect(res.status).toBe(201)

    const [row] = await testDb().select().from(lists)
    expect(await itemsOf(row?.id ?? '')).toHaveLength(ITEMS_PER_LIST_MAX)
  })

  describe('断るもの', () => {
    it('🔴 読めない版は理由が分かる形で断る', async () => {
      const me = await signIn('oldversion@example.com')

      const res = await restore(me.headers, exportFile({ version: 999 }))

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Unsupported Export Version' })
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('🔴 未来の完了日時は断る', async () => {
      const me = await signIn('future@example.com')

      const res = await restore(
        me.headers,
        exportFile({
          list: { title: 'x', items: [{ text: 'a', completedAt: '2099-01-01T00:00:00.000Z' }] },
        }),
      )

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Future Completion Date' })
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('上限を超える本文は断る', async () => {
      const me = await signIn('long@example.com')

      const res = await restore(
        me.headers,
        exportFile({
          list: {
            title: 'x',
            items: [{ text: 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1), completedAt: null }],
          },
        }),
      )

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('🔴 知らないキーは断る', async () => {
      const me = await signIn('extra@example.com')

      const res = await restore(me.headers, exportFile({ userId: 'someone-else' }))

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('JSON でない本文でも落ちない', async () => {
      const me = await signIn('broken@example.com')

      const res = await request('/api/lists/restore', {
        method: 'POST',
        headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
        body: '{壊れている',
      })

      expect(res.status).toBe(400)
    })
  })

  describe('上限', () => {
    it('🔴 上限に達していたら読み込まない', async () => {
      const me = await signIn('limit@example.com')
      const db = testDb()

      await db.insert(lists).values(
        Array.from({ length: LISTS_PER_USER_MAX }, (_, i) => ({
          id: `list-${String(i)}`,
          userId: me.userId,
          title: 'x',
        })),
      )

      const res = await restore(me.headers, exportFile())

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'List Limit Reached' })
      expect(await db.select().from(lists)).toHaveLength(LISTS_PER_USER_MAX)
      expect(await db.select().from(items)).toEqual([])
    })

    it('🔴 既存のリストが書き換わらない', async () => {
      const me = await signIn('existing@example.com')
      const db = testDb()

      await db.insert(lists).values({ id: 'existing', userId: me.userId, title: '既存' })
      await db
        .insert(items)
        .values({ id: 'kept', listId: 'existing', text: '既存の項目', position: 0 })

      await restore(me.headers, exportFile())

      expect((await itemsOf('existing')).map((row) => row.text)).toEqual(['既存の項目'])
      expect(await db.select().from(lists)).toHaveLength(2)
    })
  })

  describe('localStorage からの取り込みとの境界', () => {
    it('🔴 取り込みの経路は完了日時を受け取らないまま', async () => {
      // ここが通るようになると、未ログインでは印を付けられない（#77）が
      // 要求の組み立てだけで迂回できる
      const me = await signIn('boundary@example.com')

      const res = await request('/api/lists/import', {
        method: 'POST',
        headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ text: 'x', completedAt: '2026-05-01T00:00:00.000Z' }],
        }),
      })

      expect(res.status).toBe(400)
    })
  })
})
