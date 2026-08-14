import { env } from 'cloudflare:workers'
import { COMPLETED_PRECISIONS } from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { createTestUser, testDb } from './helpers'

/**
 * `items` テーブルの制約のテスト（#87）。
 *
 * ここで見るのは**DB が何を止めるか**だけ。API と画面は #89 / #91。
 * 型で防いでいるものも、生 SQL で迂回して DB 側が止めることを確認する
 * （`lists.test.ts` と同じ考え方）。
 */

/**
 * 項目を入れる先のリストを1つ作り、その id を返す。
 *
 * 所有者のメールアドレスは毎回変える。`users.email` は一意なので、
 * 1つのテストで2つ作ると衝突する。
 */
async function createTestList(): Promise<string> {
  const userId = await createTestUser(`${crypto.randomUUID()}@example.com`)
  const id = crypto.randomUUID()

  await testDb().insert(lists).values({ id, userId, title: 'やりたいことリスト' })

  return id
}

describe('items テーブル', () => {
  it('必須の列だけで insert できる。完了日時は NULL で始まる', async () => {
    const db = testDb()
    const listId = await createTestList()

    await db.insert(items).values({ id: 'item-1', listId, text: '南極に行く', position: 0 })

    const [row] = await db.select().from(items)

    // 完了は真偽値ではなく日時（PRODUCT_SPEC.md §3）。未完了は NULL
    expect(row?.completedAt).toBeNull()
    // 粒度も NULL で始まる。**未完了はこの列が NULL であること**（#279）
    expect(row?.completedPrecision).toBeNull()
    expect(row?.text).toBe('南極に行く')
    expect(row?.position).toBe(0)
  })

  it('created_at と updated_at に現在時刻が入る', async () => {
    const db = testDb()
    const listId = await createTestList()
    const before = Date.now()

    await db.insert(items).values({ id: 'item-1', listId, text: 'x', position: 0 })

    const [row] = await db.select().from(items)

    // timestamp_ms モードなので Date で返る。秒精度の既定値だと桁が狂うため範囲で見る
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(row?.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('完了日時を入れて読み戻せる', async () => {
    const db = testDb()
    const listId = await createTestList()
    const completedAt = new Date(1_700_000_000_000)

    // 🔴 **粒度も一緒に入れる**（#279）。日時だけを入れる行は DB が拒否する
    // （下の「完了日の粒度」のテスト）
    await db
      .insert(items)
      .values({
        id: 'item-1',
        listId,
        text: 'x',
        position: 0,
        completedAt,
        completedPrecision: 'day',
      })

    const [row] = await db.select().from(items)

    expect(row?.completedAt?.getTime()).toBe(1_700_000_000_000)
    expect(row?.completedPrecision).toBe('day')
  })

  describe('属するリスト（list_id）', () => {
    it('リストに属さない項目は作れない', async () => {
      // 型では防いでいるが、DB でも止まることを確認する
      const insert = env.DB.prepare(
        "insert into items (id, text, position) values ('item-1', 'x', 0)",
      ).run()

      await expect(insert).rejects.toThrow(/NOT NULL constraint failed/)
    })

    it('存在しないリストには入れられない', async () => {
      const insert = env.DB.prepare(
        "insert into items (id, list_id, text, position) values ('item-1', 'no-such-list', 'x', 0)",
      ).run()

      await expect(insert).rejects.toThrow(/FOREIGN KEY constraint failed/)
    })

    it('🔴 リストを消すと項目も消える', async () => {
      // 消し残すと、持ち主のいない項目が取り入れ面（#10）に出る事故につながる
      const db = testDb()
      const listId = await createTestList()
      await db.insert(items).values({ id: 'item-1', listId, text: 'x', position: 0 })

      await db.delete(lists).where(eq(lists.id, listId))

      expect(await db.select().from(items)).toEqual([])
    })
  })

  describe('並び順（position）', () => {
    it('負の並び順は DB が拒否する', async () => {
      const listId = await createTestList()

      const insert = env.DB.prepare(
        'insert into items (id, list_id, text, position) values (?, ?, ?, -1)',
      )
        .bind('item-1', listId, 'x')
        .run()

      await expect(insert).rejects.toThrow(/CHECK constraint failed/)
    })

    it('並び順が無い項目は作れない', async () => {
      const listId = await createTestList()

      const insert = env.DB.prepare('insert into items (id, list_id, text) values (?, ?, ?)')
        .bind('item-1', listId, 'x')
        .run()

      await expect(insert).rejects.toThrow(/NOT NULL constraint failed/)
    })

    it('同じ並び順を一時的に持てる（入れ替えのため一意制約を付けていない）', async () => {
      // 一意にすると、0 と 1 を交換するのに退避用の値が要る。
      // 1リスト100件が上限なので、並び替えは全件書き直しでよい（TECH_STACK.md §7）
      const db = testDb()
      const listId = await createTestList()

      await db.insert(items).values([
        { id: 'item-1', listId, text: 'a', position: 0 },
        { id: 'item-2', listId, text: 'b', position: 0 },
      ])

      expect(await db.select().from(items)).toHaveLength(2)
    })

    it('別のリストなら同じ並び順を持てる', async () => {
      const db = testDb()
      const listA = await createTestList()
      const listB = await createTestList()

      await db.insert(items).values([
        { id: 'item-1', listId: listA, text: 'a', position: 0 },
        { id: 'item-2', listId: listB, text: 'b', position: 0 },
      ])

      expect(await db.select().from(items)).toHaveLength(2)
    })
  })

  /**
   * 完了日の粒度（#279）。**DB でも組み合わせを止める**（マイグレーション 0016）。
   *
   * 止めているのはトリガー。SQLite は既存の表に CHECK を後から足せないため
   * （`0006` の件数上限と同じ折り合い）。
   */
  describe('完了日の粒度（completed_precision）', () => {
    /** 生 SQL で入れる。**型を迂回して、DB 側が止めることを確かめる** */
    const insertRaw = (listId: string, completedAt: number | null, precision: string | null) =>
      env.DB.prepare(
        'insert into items (id, list_id, text, position, completed_at, completed_precision) values (?, ?, ?, ?, ?, ?)',
      )
        .bind(crypto.randomUUID(), listId, '南極に行く', 0, completedAt, precision)
        .run()

    it('未完了・日付なし・日付ありの3通りは入る', async () => {
      const listId = await createTestList()

      await insertRaw(listId, null, null)
      await insertRaw(listId, null, 'unknown')
      await insertRaw(listId, 1_700_000_000_000, 'day')

      expect(await testDb().select().from(items)).toHaveLength(3)
    })

    it('🔴 日付なしの完了に日時を持たせられない', async () => {
      const listId = await createTestList()

      await expect(insertRaw(listId, 1_700_000_000_000, 'unknown')).rejects.toThrow(
        /invalid completed_precision/,
      )
    })

    it('🔴 未完了（粒度なし）に日時を持たせられない', async () => {
      // ここを許すと「完了していないのに完了日がある」行ができ、
      // #279 より前のデータと見分けが付かなくなる
      const listId = await createTestList()

      await expect(insertRaw(listId, 1_700_000_000_000, null)).rejects.toThrow(
        /invalid completed_precision/,
      )
    })

    it('🔴 日付のある粒度は日時が必須', async () => {
      const listId = await createTestList()

      for (const precision of ['day', 'month', 'year']) {
        await expect(insertRaw(listId, null, precision)).rejects.toThrow(
          /invalid completed_precision/,
        )
      }
    })

    it('🔴 知らない粒度は入らない', async () => {
      const listId = await createTestList()

      await expect(insertRaw(listId, null, 'decade')).rejects.toThrow(/invalid completed_precision/)
    })

    it('🔴 update でも同じ形を保つ（経路が1つという前提に頼らない）', async () => {
      const listId = await createTestList()
      await insertRaw(listId, null, 'unknown')

      const [row] = await testDb().select().from(items)

      // 日時だけを入れる（粒度は unknown のまま）
      await expect(
        env.DB.prepare('update items set completed_at = ? where id = ?')
          .bind(1_700_000_000_000, row?.id ?? '')
          .run(),
      ).rejects.toThrow(/invalid completed_precision/)

      // 粒度だけを day にする（日時が無いまま）
      await expect(
        env.DB.prepare('update items set completed_precision = ? where id = ?')
          .bind('day', row?.id ?? '')
          .run(),
      ).rejects.toThrow(/invalid completed_precision/)
    })

    it('🔴 DB が受け付ける粒度が COMPLETED_PRECISIONS と一致する', async () => {
      // トリガーの SQL には粒度の値が直接書いてある（マイグレーション 0016）。
      // 情報源は packages/shared の1箇所、という不変条件との折り合いとして、
      // **ここで一致を固定する。** 値を増やすとこのテストが落ちるので、
      // マイグレーションの追加を忘れられない
      const listId = await createTestList()

      for (const precision of COMPLETED_PRECISIONS) {
        // 日付を持たない粒度は日時なし、持つ粒度は日時ありで入れる
        const completedAt = precision === 'unknown' ? null : 1_700_000_000_000

        await insertRaw(listId, completedAt, precision)
      }

      expect(await testDb().select().from(items)).toHaveLength(COMPLETED_PRECISIONS.length)
    })
  })

  describe('文字数と件数の上限', () => {
    it('DB は文字数を止めない（上限の情報源は packages/shared の Zod）', async () => {
      // 上限を SQL にも書くと情報源が2箇所になる（CLAUDE.md の不変条件）。
      // ここが通ることを固定しておかないと、「DB が守ってくれている」と誤解する
      const db = testDb()
      const listId = await createTestList()

      await db.insert(items).values({ id: 'item-1', listId, text: 'あ'.repeat(1000), position: 0 })

      expect(await db.select().from(items)).toHaveLength(1)
    })
  })
})
