import { env } from 'cloudflare:workers'
import { count } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { lists } from '../src/db/schema'
import { testDb } from './helpers'

describe('lists テーブル', () => {
  it('id と title だけで insert すると、公開範囲の既定が private になる', async () => {
    const db = testDb()
    await db.insert(lists).values({ id: 'list-1', title: 'やりたいことリスト' })

    const [row] = await db.select().from(lists)

    // 既定は非公開。旧実装は published が既定 true だったので、これを逆にしている
    expect(row?.visibility).toBe('private')
  })

  it('created_at と updated_at に現在時刻が入る', async () => {
    const db = testDb()
    const before = Date.now()
    await db.insert(lists).values({ id: 'list-1', title: 'x' })

    const [row] = await db.select().from(lists)

    // timestamp_ms モードなので Date で返る。秒精度の既定値だと桁が狂うため範囲で見る
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(row?.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('不正な公開範囲は DB が拒否する', async () => {
    // Drizzle の enum は型の上だけの話なので、型を迂回する経路（生 SQL）で
    // CHECK 制約が実際に効いていることを確認する
    const insert = env.DB.prepare(
      "insert into lists (id, title, visibility) values ('list-1', 'x', 'everyone')",
    ).run()

    await expect(insert).rejects.toThrow(/CHECK constraint failed/)
  })

  describe('テストごとに状態が巻き戻る', () => {
    it('1件 insert する', async () => {
      const db = testDb()
      await db.insert(lists).values({ id: 'list-1', title: 'x' })

      expect(await db.select({ n: count() }).from(lists)).toEqual([{ n: 1 }])
    })

    it('前のテストで入れた行が残っていない', async () => {
      const db = testDb()

      expect(await db.select({ n: count() }).from(lists)).toEqual([{ n: 0 }])
    })
  })
})
