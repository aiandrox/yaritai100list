import { exports } from 'cloudflare:workers'
import { ITEMS_PER_LIST_MAX } from '@yaritai100list/shared'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { adoptions, items, lists } from '../src/db/schema'
import { createTestUser, signIn, testBaseUrl, testDb } from './helpers'

/**
 * 取り入れ API のテスト（#234 / 親 #10）。
 *
 * 🔴 見るのは **「人気指標を作れないこと」** と **「他人のリストに入れられないこと」。**
 *
 * 前者がこの機能に固有の穴。プールに無い本文を送れると、
 * **この口から好きな本文の取り入れ数を積める**（`PRODUCT_SPEC.md` §5.4 の指標が嘘になる）。
 */

const POOLED = 'プールにある本文'

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

function adopt(headers: Headers, listId: string, text: string) {
  return request(`/api/lists/${listId}/adopt`, {
    method: 'POST',
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

/** 全公開のリストを1つ作って、プールに本文を流す。 */
async function seedPool(
  texts: string[] = [POOLED],
  visibility: 'private' | 'unlisted' | 'public' = 'public',
) {
  const db = testDb()
  const userId = await createTestUser(`pool-${crypto.randomUUID()}@example.com`)
  const listId = crypto.randomUUID()

  await db.insert(lists).values({
    id: listId,
    userId,
    title: 'x',
    visibility,
    shareId: crypto.randomUUID().replaceAll('-', ''),
  })
  const rows = texts.map((text, position) => ({
    id: crypto.randomUUID(),
    listId,
    text,
    position,
  }))

  // ⚠️ **1文にまとめない。** D1 はバインド変数の数に上限がある（#89 で踏んだ）
  for (let i = 0; i < rows.length; i += 20) {
    await db.insert(items).values(rows.slice(i, i + 20))
  }
}

/**
 * 制限に当たるまで叩くのを諦める回数。**枠より十分大きく、しかし小さく。**
 *
 * 枠の値はここに書かない（`rate-limit.test.ts` と同じ方針）。
 * 設定は `wrangler.jsonc` と `vitest.config.ts` にあり、どちらを変えても追随させる。
 */
const GIVE_UP_AT = 30

/** 取り入れ先の自分のリスト。 */
async function myList() {
  const me = await signIn(`me-${crypto.randomUUID()}@example.com`)
  const listId = crypto.randomUUID()

  await testDb()
    .insert(lists)
    .values({
      id: listId,
      userId: me.userId,
      title: '自分のリスト',
      shareId: crypto.randomUUID().replaceAll('-', ''),
    })

  return { ...me, listId }
}

const itemsOf = (listId: string) =>
  testDb().select().from(items).where(eq(items.listId, listId)).orderBy(asc(items.position))

describe('POST /api/lists/:listId/adopt', () => {
  it('自分のリストの末尾に入る', async () => {
    await seedPool()
    const me = await myList()
    await testDb()
      .insert(items)
      .values({ id: 'first', listId: me.listId, text: '先にあった項目', position: 0 })

    const res = await adopt(me.headers, me.listId, POOLED)

    expect(res.status).toBe(201)

    const rows = await itemsOf(me.listId)
    expect(rows.map((row) => row.text)).toEqual(['先にあった項目', POOLED])
  })

  it('🔴 完了状態が引き継がれていない', async () => {
    // 他人が叶えたことは自分の達成ではない
    await seedPool()
    await testDb().update(items).set({ completedAt: new Date() })

    const me = await myList()
    await adopt(me.headers, me.listId, POOLED)

    expect((await itemsOf(me.listId))[0]?.completedAt).toBeNull()
  })

  it('取り入れの記録が1行残る', async () => {
    await seedPool()
    const me = await myList()

    await adopt(me.headers, me.listId, POOLED)

    const [row] = await testDb().select().from(adoptions)
    expect(row?.sourceText).toBe(POOLED)
    expect(row?.adopterItemId).toBe((await itemsOf(me.listId))[0]?.id)
  })

  describe('人気指標を作れないこと', () => {
    it('🔴 プールに無い本文は取り入れられない', async () => {
      // ここが通ると、この口から好きな本文の取り入れ数を積める
      await seedPool()
      const me = await myList()

      const res = await adopt(me.headers, me.listId, 'どこにも書かれていない本文')

      expect(res.status).toBe(404)
      expect(await testDb().select().from(adoptions)).toEqual([])
      expect(await itemsOf(me.listId)).toEqual([])
    })

    it('🔴 リンク限定公開のリストの本文は取り入れられない', async () => {
      await seedPool(['リンク限定の本文'], 'unlisted')
      const me = await myList()

      const res = await adopt(me.headers, me.listId, 'リンク限定の本文')

      expect(res.status).toBe(404)
      expect(await testDb().select().from(adoptions)).toEqual([])
    })

    it('🔴 非公開リストの本文は取り入れられない', async () => {
      await seedPool(['非公開の本文'], 'private')
      const me = await myList()

      expect((await adopt(me.headers, me.listId, '非公開の本文')).status).toBe(404)
    })

    it('🔴 完了状態を送り込めない', async () => {
      await seedPool()
      const me = await myList()

      const res = await request(`/api/lists/${me.listId}/adopt`, {
        method: 'POST',
        headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
        body: JSON.stringify({ text: POOLED, completed: true }),
      })

      // `.strict()` が知らない鍵を弾く
      expect(res.status).toBe(400)
    })
  })

  describe('断るもの', () => {
    it('🔴 同じ本文を2回取り入れられない', async () => {
      await seedPool()
      const me = await myList()

      expect((await adopt(me.headers, me.listId, POOLED)).status).toBe(201)

      const second = await adopt(me.headers, me.listId, POOLED)

      expect(second.status).toBe(409)
      expect(await second.json()).toEqual({ error: 'Already Adopted' })
      expect(await itemsOf(me.listId)).toHaveLength(1)
    })

    it('🔴 未ログインでは取り入れられない', async () => {
      // 未ログインの経路はクライアント側（#236）。サーバーには記録を残さない
      await seedPool()
      const me = await myList()

      const res = await adopt(new Headers(), me.listId, POOLED)

      expect(res.status).toBe(401)
      expect(await testDb().select().from(adoptions)).toEqual([])
    })

    it('🔴 他人のリストには取り入れられない', async () => {
      await seedPool()
      const owner = await myList()
      const stranger = await signIn(`stranger-${crypto.randomUUID()}@example.com`)

      const res = await adopt(stranger.headers, owner.listId, POOLED)

      expect(res.status).toBe(404)
      expect(await itemsOf(owner.listId)).toEqual([])
    })

    it('100件埋まっていたら断る', async () => {
      await seedPool()
      const me = await myList()

      const rows = Array.from({ length: ITEMS_PER_LIST_MAX }, (_, i) => ({
        id: `full-${String(i)}`,
        listId: me.listId,
        text: `埋まっている${String(i)}`,
        position: i,
      }))
      for (let i = 0; i < rows.length; i += 20) {
        await testDb()
          .insert(items)
          .values(rows.slice(i, i + 20))
      }

      const res = await adopt(me.headers, me.listId, POOLED)

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'Item Limit Reached' })
      expect(await itemsOf(me.listId)).toHaveLength(ITEMS_PER_LIST_MAX)
    })

    it('🔴 「もう持っている」と「枠が無い」を分けて返す', async () => {
      // 次にやることが違う（消すのか、整理するのか）
      await seedPool()
      const me = await myList()
      await adopt(me.headers, me.listId, POOLED)

      const duplicate = await adopt(me.headers, me.listId, POOLED)

      expect(await duplicate.json()).toEqual({ error: 'Already Adopted' })
    })

    it('叩き続けると 429', async () => {
      // **毎回違う本文を送る。** 同じ本文だと 409 で先に断られ、制限まで届かない
      await seedPool(Array.from({ length: GIVE_UP_AT }, (_, i) => `プール${String(i)}`))
      const me = await myList()

      let limited: Response | null = null
      for (let i = 0; i < GIVE_UP_AT; i++) {
        const res = await adopt(me.headers, me.listId, `プール${String(i)}`)
        if (res.status === 429) {
          limited = res
          break
        }
      }

      expect(limited).not.toBeNull()
      expect(await limited?.json()).toEqual({ error: 'Too Many Requests' })
    })
  })

  describe('関係が切れるとき', () => {
    it('🔴 本文を書き換えると記録が消える', async () => {
      // 書き換えたら、それはもう取り入れた項目ではない（#87）
      await seedPool()
      const me = await myList()
      await adopt(me.headers, me.listId, POOLED)

      const [item] = await itemsOf(me.listId)
      await request(`/api/lists/${me.listId}/items/${item?.id ?? ''}`, {
        method: 'PATCH',
        headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
        body: JSON.stringify({ text: '自分の言葉に書き換えた' }),
      })

      expect(await testDb().select().from(adoptions)).toEqual([])
    })

    it('🔴 完了にしただけでは記録が消えない', async () => {
      // トリガーに `WHEN NEW.text <> OLD.text` が無いとここが落ちる
      await seedPool()
      const me = await myList()
      await adopt(me.headers, me.listId, POOLED)

      const [item] = await itemsOf(me.listId)
      await request(`/api/lists/${me.listId}/items/${item?.id ?? ''}`, {
        method: 'PATCH',
        headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      })

      expect(await testDb().select().from(adoptions)).toHaveLength(1)
    })

    it('🔴 同じ本文で上書きしても記録は残る', async () => {
      await seedPool()
      const me = await myList()
      await adopt(me.headers, me.listId, POOLED)

      const [item] = await itemsOf(me.listId)
      await request(`/api/lists/${me.listId}/items/${item?.id ?? ''}`, {
        method: 'PATCH',
        headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
        body: JSON.stringify({ text: POOLED }),
      })

      expect(await testDb().select().from(adoptions)).toHaveLength(1)
    })

    it('🔴 取り入れた項目を消すと記録も消える（cascade）', async () => {
      await seedPool()
      const me = await myList()
      await adopt(me.headers, me.listId, POOLED)

      const [item] = await itemsOf(me.listId)
      await request(`/api/lists/${me.listId}/items/${item?.id ?? ''}`, {
        method: 'DELETE',
        headers: Object.fromEntries(me.headers),
      })

      expect(await testDb().select().from(adoptions)).toEqual([])
    })
  })
})
