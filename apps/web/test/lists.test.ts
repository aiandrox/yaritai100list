import { env } from 'cloudflare:workers'
import { count, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { lists, users } from '../src/db/schema'
import { createTestUser, testDb } from './helpers'

describe('lists テーブル', () => {
  it('必須の列だけで insert すると、公開範囲の既定が private になる', async () => {
    const db = testDb()
    const userId = await createTestUser()
    await db.insert(lists).values({ id: 'list-1', userId, title: 'やりたいことリスト' })

    const [row] = await db.select().from(lists)

    // 既定は非公開。旧実装は published が既定 true だったので、これを逆にしている
    expect(row?.visibility).toBe('private')
  })

  it('created_at と updated_at に現在時刻が入る', async () => {
    const db = testDb()
    const userId = await createTestUser()
    const before = Date.now()
    await db.insert(lists).values({ id: 'list-1', userId, title: 'x' })

    const [row] = await db.select().from(lists)

    // timestamp_ms モードなので Date で返る。秒精度の既定値だと桁が狂うため範囲で見る
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(row?.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('不正な公開範囲は DB が拒否する', async () => {
    const userId = await createTestUser()

    // Drizzle の enum は型の上だけの話なので、型を迂回する経路（生 SQL）で
    // CHECK 制約が実際に効いていることを確認する
    const insert = env.DB.prepare(
      "insert into lists (id, user_id, title, visibility) values ('list-1', ?, 'x', 'everyone')",
    )
      .bind(userId)
      .run()

    await expect(insert).rejects.toThrow(/CHECK constraint failed/)
  })

  describe('所有者（user_id）', () => {
    it('所有者のいないリストは作れない', async () => {
      // 型では防いでいるが、DB でも止まることを確認する
      const insert = env.DB.prepare("insert into lists (id, title) values ('list-1', 'x')").run()

      await expect(insert).rejects.toThrow(/NOT NULL constraint failed/)
    })

    it('存在しない利用者を所有者にできない', async () => {
      const insert = env.DB.prepare(
        "insert into lists (id, user_id, title) values ('list-1', 'no-such-user', 'x')",
      ).run()

      await expect(insert).rejects.toThrow(/FOREIGN KEY constraint failed/)
    })

    it('利用者を消すとリストも消える', async () => {
      const db = testDb()
      const userId = await createTestUser()
      await db.insert(lists).values({ id: 'list-1', userId, title: 'x' })

      await db.delete(users).where(eq(users.id, userId))

      expect(await db.select().from(lists)).toEqual([])
    })
  })

  describe('テストごとに状態が巻き戻る', () => {
    it('1件 insert する', async () => {
      const db = testDb()
      const userId = await createTestUser()
      await db.insert(lists).values({ id: 'list-1', userId, title: 'x' })

      expect(await db.select({ n: count() }).from(lists)).toEqual([{ n: 1 }])
    })

    it('前のテストで入れた行が残っていない', async () => {
      const db = testDb()

      expect(await db.select({ n: count() }).from(lists)).toEqual([{ n: 0 }])
    })
  })
})
