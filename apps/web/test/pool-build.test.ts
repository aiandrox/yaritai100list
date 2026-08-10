import { and, asc, desc, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import { items, lists, pool, wishTexts } from '../src/db/schema'
import { rebuildPool } from '../src/pool'
import { testDb } from './helpers'
import { makeList, runBatch } from './pool-helpers'

/**
 * プールを作り直すバッチのテスト（#254 / 親 #252）。
 *
 * 🔴 見るのは4つ。
 *
 * - **出してはいけない本文が入らないこと**（リンク限定公開・非公開・判定に落ちたもの）。
 *   ここが漏れると、取り入れ面に出てから次のバッチまで残る
 * - **人数の数え方**（出す範囲と数える範囲が違う。非公開も数に入る）
 * - **総入れ替えであること**（消えた本文が残らない）
 * - **プールが空になる瞬間が無いこと**（1トランザクション）
 *
 * 応答の形は `discover-api.test.ts`。ここは表の中身だけを見る。
 */

/** プールの中身を人気順で読む。 */
async function readTable() {
  return await testDb()
    .select({ canonical: pool.canonical, genre: pool.genre, writers: pool.writers })
    .from(pool)
    .orderBy(desc(pool.writers), asc(pool.canonical))
}

const canonicals = (rows: { canonical: string }[]) => rows.map((row) => row.canonical)

describe('rebuildPool', () => {
  it('1件も無くても落ちない（初日に必ず通る）', async () => {
    await rebuildPool(testDb())

    expect(await readTable()).toEqual([])
  })

  describe('入れる本文', () => {
    it('🔴 リンク限定公開のリストにしか無い本文は入らない', async () => {
      await makeList({ id: 'u1', visibility: 'unlisted', texts: ['リンク限定の項目'] })
      await runBatch({ リンク限定の項目: {} })

      expect(await readTable()).toEqual([])
    })

    it('🔴 非公開リストにしか無い本文は入らない', async () => {
      await makeList({ id: 's1', visibility: 'private', texts: ['非公開の項目'] })
      await runBatch({ 非公開の項目: {} })

      expect(await readTable()).toEqual([])
    })

    it('🔴 判定に落ちた本文は入らない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['田中太郎に告白する'] })
      await runBatch({ 田中太郎に告白する: { verdict: 'ng' } })

      expect(await readTable()).toEqual([])
    })

    it('🔴 まだ判定していない本文は入らない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['まだ判定していない'] })
      await rebuildPool(testDb())

      expect(await readTable()).toEqual([])
    })

    it('ジャンルを持つ（ジャンル別の入口は #255）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['オーロラを見る'] })
      await runBatch({ オーロラを見る: { genre: 'travel' } })

      expect(await readTable()).toEqual([
        { canonical: 'オーロラを見る', genre: 'travel', writers: 1 },
      ])
    })
  })

  describe('代表表現でまとめる', () => {
    it('🔴 「富士山に登る」「富士山登頂」が1行にまとまる', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['富士山登頂'] })
      await runBatch({
        富士山に登りたい: { canonical: '富士山に登る' },
        富士山登頂: { canonical: '富士山に登る' },
      })

      expect(await readTable()).toEqual([{ canonical: '富士山に登る', genre: 'other', writers: 2 }])
    })

    it('🔴 まとまった行の人数が両方の書き手を数えている', async () => {
      // 数え損ねると、名寄せするほど順位が下がることになる
      await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['富士山登頂'] })
      await makeList({ id: 'p3', visibility: 'public', texts: ['富士山に登る'] })
      await runBatch({
        富士山に登りたい: { canonical: '富士山に登る' },
        富士山登頂: { canonical: '富士山に登る' },
      })

      expect((await readTable())[0]?.writers).toBe(3)
    })

    it('ジャンルが割れても1つに決まる（毎回同じ）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['富士山登頂'] })
      await runBatch({
        富士山に登りたい: { canonical: '富士山に登る', genre: 'travel' },
        富士山登頂: { canonical: '富士山に登る', genre: 'challenge' },
      })

      const first = await readTable()
      await rebuildPool(testDb())

      expect(await readTable()).toEqual(first)
    })
  })

  describe('人数の数え方', () => {
    it('🔴 出すのは全公開の本文だけ、数えるのは全リスト', async () => {
      // 数える範囲を全公開だけにすると、公開リストが少ないうちは全部1人で順序が付かない
      await makeList({ id: 'p1', visibility: 'public', texts: ['かくれて人気'] })
      await makeList({ id: 's1', visibility: 'private', texts: ['かくれて人気'] })
      await makeList({ id: 'u1', visibility: 'unlisted', texts: ['かくれて人気'] })
      await runBatch()

      expect((await readTable())[0]?.writers).toBe(3)
    })

    it('🔴 同じ人が何度書いても1人（リストを増やして上位に来られない）', async () => {
      const { userId } = await makeList({ id: 'p1', visibility: 'public', texts: ['連投'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['連投'], userId })
      await makeList({ id: 'p3', visibility: 'public', texts: ['連投'], userId })
      await runBatch()

      expect((await readTable())[0]?.writers).toBe(1)
    })

    it('同じリストに2回書いても1人', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['同じことを2回', '同じことを2回'] })
      await runBatch()

      expect((await readTable())[0]?.writers).toBe(1)
    })
  })

  describe('総入れ替え', () => {
    it('🔴 全公開をやめた本文が次のバッチで消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await runBatch()
      expect(canonicals(await readTable())).toEqual(['南極に行く'])

      await testDb().update(lists).set({ visibility: 'private' })
      await runBatch()

      expect(await readTable()).toEqual([])
    })

    it('🔴 書き換えられた本文が残らない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['書き換える前'] })
      await runBatch()

      await testDb().update(items).set({ text: '書き換えた後' })
      await runBatch()

      expect(canonicals(await readTable())).toEqual(['書き換えた後'])
    })

    it('🔴 判定を ng に変えると次のバッチで消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['あとから ng'] })
      await runBatch()

      await testDb()
        .update(wishTexts)
        .set({ verdict: 'ng', canonical: null, genre: null })
        .where(eq(wishTexts.rawText, 'あとから ng'))
      await rebuildPool(testDb())

      expect(await readTable()).toEqual([])
    })

    it('🔴 作り直しても中身が同じなら結果が変わらない（何度回しても安全）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B'] })
      await runBatch()
      const first = await readTable()

      await runBatch()

      expect(await readTable()).toEqual(first)
    })
  })

  /**
   * 共有で見せない項目（#237）は、プールでも「書いていない」扱いにする。
   *
   * `makeList` は項目単位のオプションを持たないので、作った後で
   * 直接 `hidden_in_share` を立てる（本文と持ち主で絞って更新する）。
   */
  describe('共有で見せない項目（#237）', () => {
    /** 指定した本文の項目を、指定したリストの中だけ隠す。 */
    async function hide(listId: string, text: string) {
      await testDb()
        .update(items)
        .set({ hiddenInShare: true })
        .where(and(eq(items.listId, listId), eq(items.text, text)))
    }

    it('🔴 全公開リストにしかなく、隠されている本文はプールに出ない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['隠したい項目'] })
      await hide('p1', '隠したい項目')
      await runBatch()

      expect(await readTable()).toEqual([])
    })

    it('🔴 隠した項目は人数のカウントにも入らない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['かくれない人気'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['かくれない人気'] })
      await hide('p2', 'かくれない人気')
      await runBatch()

      expect((await readTable())[0]?.writers).toBe(1)
    })
  })

  /**
   * 🔴 **プールが空になる瞬間を作らない。**
   *
   * 消すのと入れるのを別のトランザクションにすると、**間で落ちたときに
   * 次のバッチまでプールが空**になる（取り入れ面が丸ごと消える）。
   * 落とす手段が無いので、**1トランザクションであること自体**を見る。
   */
  it('🔴 消すのと入れるのが1トランザクション', async () => {
    await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
    await runBatch()

    const db = testDb()
    const original = db.batch.bind(db)
    const calls: number[] = []

    db.batch = vi.fn((...args: Parameters<typeof original>) => {
      calls.push(args[0].length)
      return original(...args)
    }) as unknown as typeof db.batch

    await rebuildPool(db)

    // 消す1文と入れる1文が、同じ `batch`（= 同じトランザクション）に入っている
    expect(calls).toEqual([2])
    expect(canonicals(await readTable())).toEqual(['南極に行く'])
  })
})
