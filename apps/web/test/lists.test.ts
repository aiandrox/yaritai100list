import { env } from 'cloudflare:workers'
import { LISTS_PER_USER_MAX } from '@yaritai100list/shared'
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
      "insert into lists (id, user_id, title, share_id, visibility) values ('list-1', ?, 'x', 's1', 'everyone')",
    )
      .bind(userId)
      .run()

    await expect(insert).rejects.toThrow(/CHECK constraint failed/)
  })

  describe('所有者（user_id）', () => {
    it('所有者のいないリストは作れない', async () => {
      // 型では防いでいるが、DB でも止まることを確認する
      const insert = env.DB.prepare(
        "insert into lists (id, title, share_id) values ('list-1', 'x', 's1')",
      ).run()

      await expect(insert).rejects.toThrow(/NOT NULL constraint failed/)
    })

    it('存在しない利用者を所有者にできない', async () => {
      const insert = env.DB.prepare(
        "insert into lists (id, user_id, title, share_id) values ('list-1', 'no-such-user', 'x', 's1')",
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

  describe('公開用の ID（share_id）', () => {
    it('渡さなくても入る。連番ではない', async () => {
      const db = testDb()
      const userId = await createTestUser()

      await db.insert(lists).values([
        { id: 'list-1', userId, title: 'x' },
        { id: 'list-2', userId, title: 'y' },
      ])

      const rows = await db.select().from(lists)
      const shareIds = rows.map((row) => row.shareId)

      expect(shareIds.every((id) => id.length >= 32)).toBe(true)
      expect(new Set(shareIds).size).toBe(2)
      expect(shareIds[0]).not.toMatch(/^\d+$/)
    })

    it('🔴 編集用の ID とは別の値', async () => {
      // 同じにすると、公開 URL から編集 URL が分かってしまう（TECH_STACK.md §7）
      const db = testDb()
      const userId = await createTestUser()
      await db.insert(lists).values({ id: 'list-1', userId, title: 'x' })

      const [row] = await db.select().from(lists)

      expect(row?.shareId).not.toBe(row?.id)
    })

    it('🔴 重複した値は DB が拒否する', async () => {
      // 生 SQL で叩く。Drizzle 経由だと元の理由がラップされて読めない
      const userId = await createTestUser()
      const insert = (id: string) =>
        env.DB.prepare('insert into lists (id, user_id, title, share_id) values (?, ?, ?, ?)')
          .bind(id, userId, 'x', 'same')
          .run()

      await insert('list-1')

      await expect(insert('list-2')).rejects.toThrow(/UNIQUE constraint failed/)
    })

    it('🔴 空（NULL）では入れられない', async () => {
      // 列の宣言は NULL 可のままなので、DB 側の縛りはトリガーで作っている
      // （既存の行があるためテーブルを作り直せなかった。マイグレーション 0007）
      const userId = await createTestUser()

      const insert = env.DB.prepare('insert into lists (id, user_id, title) values (?, ?, ?)')
        .bind('list-1', userId, 'x')
        .run()

      await expect(insert).rejects.toThrow(/share_id is required/)
    })

    it('🔴 後から NULL にもできない', async () => {
      const db = testDb()
      const userId = await createTestUser()
      await db.insert(lists).values({ id: 'list-1', userId, title: 'x' })

      const update = env.DB.prepare('update lists set share_id = null where id = ?')
        .bind('list-1')
        .run()

      await expect(update).rejects.toThrow(/share_id is required/)
    })
  })

  describe('1人あたりの上限（DB のトリガー）', () => {
    /** その利用者のリストを `count` 件まで埋める。 */
    async function fill(userId: string, count: number, prefix = 'list') {
      const db = testDb()

      for (let i = 0; i < count; i++) {
        await db.insert(lists).values({ id: `${prefix}-${String(i)}`, userId, title: 'x' })
      }
    }

    it('🔴 上限を超える insert を DB が拒否する', async () => {
      // アプリ側でも止めているが、**アプリコードだけに頼らない**（TECH_STACK.md §7）
      const userId = await createTestUser()
      await fill(userId, LISTS_PER_USER_MAX)

      const insert = env.DB.prepare(
        'insert into lists (id, user_id, title, share_id) values (?, ?, ?, ?)',
      )
        .bind('over', userId, 'x', 'over-share')
        .run()

      await expect(insert).rejects.toThrow(/lists per user limit reached/)
    })

    it('🔴 DB が止める件数が LISTS_PER_USER_MAX と一致する', async () => {
      // トリガーの SQL には上限の数字が直接書いてある（マイグレーション 0006）。
      // 情報源は packages/shared の1箇所、という不変条件との折り合いとして、
      // **ここで一致を固定する。** 定数を変えるとこのテストが落ち、
      // マイグレーションの追加を忘れられない
      const userId = await createTestUser()
      await fill(userId, LISTS_PER_USER_MAX - 1)

      // 上限のちょうど手前までは入る
      await testDb().insert(lists).values({ id: 'last', userId, title: 'x' })
      expect(await testDb().select({ n: count() }).from(lists)).toEqual([{ n: LISTS_PER_USER_MAX }])

      const insert = env.DB.prepare(
        'insert into lists (id, user_id, title, share_id) values (?, ?, ?, ?)',
      )
        .bind('over', userId, 'x', 'over-share')
        .run()

      await expect(insert).rejects.toThrow(/lists per user limit reached/)
    })

    it('🔴 他人のリストは数に入らない', async () => {
      const other = await createTestUser('other@example.com')
      await fill(other, LISTS_PER_USER_MAX, 'other')

      const me = await createTestUser('me@example.com')

      await testDb().insert(lists).values({ id: 'mine', userId: me, title: 'x' })

      expect(await testDb().select().from(lists).where(eq(lists.userId, me))).toHaveLength(1)
    })

    it('🔴 持ち主を付け替えても越えられない', async () => {
      // API は user_id を受け取らないが、**経路が1つだけという前提に頼らない**
      const full = await createTestUser('full@example.com')
      await fill(full, LISTS_PER_USER_MAX, 'full')

      const other = await createTestUser('spare@example.com')
      await testDb().insert(lists).values({ id: 'moved', userId: other, title: 'x' })

      const update = env.DB.prepare('update lists set user_id = ? where id = ?')
        .bind(full, 'moved')
        .run()

      await expect(update).rejects.toThrow(/lists per user limit reached/)
    })

    it('1つ消せばまた入る', async () => {
      const userId = await createTestUser()
      await fill(userId, LISTS_PER_USER_MAX)

      await testDb().delete(lists).where(eq(lists.id, 'list-0'))

      await testDb().insert(lists).values({ id: 'again', userId, title: 'x' })

      expect(await testDb().select({ n: count() }).from(lists)).toEqual([{ n: LISTS_PER_USER_MAX }])
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
