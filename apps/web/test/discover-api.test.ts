import { exports } from 'cloudflare:workers'
import { DISCOVER_ITEMS_MAX } from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { adoptions, items, lists } from '../src/db/schema'
import { createTestUser, testBaseUrl, testDb } from './helpers'

/**
 * 取り入れ面のプールのテスト（#233 / 親 #10）。
 *
 * 🔴 見るのは **「出てはいけないものが出ないこと」** と **「並び順が毎回同じこと」。**
 *
 * 前者は認可（`docs/workflow.md` §6）。リンク限定公開の項目がプールに流れると、
 * **「URL を知っている人だけ」という約束が破れる。**
 * 後者は、同数のときに応答が揺れると画面が意味もなく並び替わるため。
 */

const discover = () => exports.default.fetch(new Request(`${testBaseUrl()}/api/discover`))

async function readPool() {
  const res = await discover()
  const body = await res.json<{ items: { text: string; adopted: number }[] }>()

  return { status: res.status, items: body.items }
}

const texts = (rows: { text: string }[]) => rows.map((row) => row.text)

/**
 * 公開範囲を指定してリストを作り、項目を入れる。
 *
 * **持ち主を分けられるようにしてある**（「書いている人数」で並べるため）。
 */
async function makeList(options: {
  id: string
  visibility: 'private' | 'unlisted' | 'public'
  texts: string[]
  userId?: string
}) {
  const db = testDb()
  const userId = options.userId ?? (await createTestUser(`${options.id}@example.com`))

  await db.insert(lists).values({
    id: options.id,
    userId,
    title: 'x',
    visibility: options.visibility,
    shareId: crypto.randomUUID().replaceAll('-', ''),
  })

  const rows = options.texts.map((text, position) => ({
    id: `${options.id}-${String(position)}`,
    listId: options.id,
    text,
    position,
  }))

  // ⚠️ **1文にまとめない。** D1 はバインド変数の数に上限があり、
  // 100件を1文で入れると `too many SQL variables` で落ちる（#89 で踏んだのと同じ）
  for (let i = 0; i < rows.length; i += 20) {
    await db.insert(items).values(rows.slice(i, i + 20))
  }

  return { userId }
}

/** 取り入れの記録を直接入れる（作る経路は #234）。 */
async function recordAdoption(adopterItemId: string, sourceText: string) {
  await testDb().insert(adoptions).values({ id: crypto.randomUUID(), adopterItemId, sourceText })
}

describe('GET /api/discover', () => {
  it('未ログインでも読める（書き始める前の人が対象）', async () => {
    await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })

    const pool = await readPool()

    expect(pool.status).toBe(200)
    expect(texts(pool.items)).toEqual(['南極に行く'])
  })

  it('1件も公開リストが無くても落ちない', async () => {
    expect((await readPool()).items).toEqual([])
  })

  describe('出てはいけないもの', () => {
    it('🔴 リンク限定公開のリストの項目が出ない', async () => {
      // ここが漏れると「URL を知っている人だけ」という約束が破れる
      await makeList({ id: 'u1', visibility: 'unlisted', texts: ['リンク限定の項目'] })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 非公開リストの項目が出ない', async () => {
      await makeList({ id: 's1', visibility: 'private', texts: ['非公開の項目'] })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 全公開を解除すると項目がプールから消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      expect(texts((await readPool()).items)).toEqual(['南極に行く'])

      await testDb().update(lists).set({ visibility: 'private' })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 作者・完了状態・リスト ID が応答に含まれない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await testDb().update(items).set({ completedAt: new Date() })

      const [row] = (await readPool()).items

      // アイデアそのものを探す場なので、叶えたかどうかは削ぎ落とす。
      // 元のリストへ辿れる値も返さない（2つの公開面を経路として交わらせない）
      expect(Object.keys(row ?? {}).sort()).toEqual(['adopted', 'text'])
    })

    it('🔴 並べるために使う「書いている人数」を応答に入れない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['南極に行く'] })

      const [row] = (await readPool()).items

      expect(row).toEqual({ text: '南極に行く', adopted: 0 })
    })
  })

  describe('本文でまとめる', () => {
    it('同じ本文が2つの公開リストにあっても1行になる', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く', 'A'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['南極に行く', 'B'] })

      expect((await readPool()).items.filter((row) => row.text === '南極に行く')).toHaveLength(1)
    })

    it('同じ人が同じ本文を別のリストに書いていても1行', async () => {
      const { userId } = await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['南極に行く'], userId })

      expect(texts((await readPool()).items)).toEqual(['南極に行く'])
    })
  })

  describe('並び順', () => {
    it('取り入れ数が多い順', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['あまり', 'よく'] })
      await makeList({ id: 'own', visibility: 'private', texts: ['自分1', '自分2', '自分3'] })

      await recordAdoption('own-0', 'よく')
      await recordAdoption('own-1', 'よく')
      await recordAdoption('own-2', 'あまり')

      expect(texts((await readPool()).items)).toEqual(['よく', 'あまり'])
    })

    it('🔴 取り入れ数が並んだら、書いている人が多い順', async () => {
      // 公開したての頃は全部 0 件なので、これが無いと初日に順序が無い
      await makeList({ id: 'p1', visibility: 'public', texts: ['みんな', 'ひとり'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['みんな'] })

      expect(texts((await readPool()).items)).toEqual(['みんな', 'ひとり'])
    })

    it('🔴 取り入れ数も人数も並んだら本文順（応答が毎回同じ）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['C', 'A', 'B'] })

      expect(texts((await readPool()).items)).toEqual(['A', 'B', 'C'])
      expect(texts((await readPool()).items)).toEqual(['A', 'B', 'C'])
    })

    it('🔴 一度も取り入れられていない本文も出る', async () => {
      // 取り入れの記録との結合で消えると、初日のプールが空になる
      await makeList({ id: 'p1', visibility: 'public', texts: ['まだ誰も取り入れていない'] })

      expect(texts((await readPool()).items)).toEqual(['まだ誰も取り入れていない'])
    })

    it('取り入れた項目を消すと人気の数から消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await makeList({ id: 'own', visibility: 'private', texts: ['自分の項目'] })
      await recordAdoption('own-0', '南極に行く')

      expect((await readPool()).items[0]?.adopted).toBe(1)

      // on delete cascade。「もう存在しない取り入れ」が数え続けないこと
      await testDb().delete(items).where(eq(items.id, 'own-0'))

      expect((await readPool()).items[0]?.adopted).toBe(0)
    })
  })

  it('出す件数に上限がある', async () => {
    const many = Array.from({ length: DISCOVER_ITEMS_MAX + 10 }, (_, i) =>
      String(i).padStart(4, '0'),
    )
    await makeList({ id: 'p1', visibility: 'public', texts: many })

    expect((await readPool()).items).toHaveLength(DISCOVER_ITEMS_MAX)
  })
})
