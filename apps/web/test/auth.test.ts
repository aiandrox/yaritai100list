import { describe, expect, it } from 'vitest'

import { testAuth, testDb } from './helpers'
import { session, user } from '../src/db/schema'

/**
 * Better Auth が **D1 のバインディング経由**で読み書きできることを確認する。
 *
 * ここが #49 の主眼。1.7 の不具合（`pragma_index_list` が D1 の authorizer に
 * 拒否される）は **`wrangler d1 execute` からは再現せず、バインディング経由でしか出ない。**
 * そのため「CLI で通ったから大丈夫」では検証にならない。
 *
 * テストは workerd の中で動き、D1 はインメモリ（`vitest.config.ts`）。
 * つまりこのテストが通ることは、本番と同じ経路で通ることを意味する。
 */
/** `user` テーブルの行。`adapter.create` の型引数に渡す */
interface UserRow {
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: Date
  updatedAt: Date
}

describe('Better Auth と D1', () => {
  it('アダプタ経由で利用者を作って読み戻せる', async () => {
    const ctx = await testAuth().$context

    const created = await ctx.adapter.create<UserRow>({
      model: 'user',
      data: {
        name: '',
        email: 'someone@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    expect(created.id).toBeTruthy()

    const found = await ctx.adapter.findOne<UserRow>({
      model: 'user',
      where: [{ field: 'email', value: 'someone@example.com' }],
    })

    expect(found?.id).toBe(created.id)
  })

  it('セッションを作れて、Drizzle 側からも同じ行が見える', async () => {
    const auth = testAuth()
    const ctx = await auth.$context

    const created = await ctx.adapter.create<UserRow>({
      model: 'user',
      data: {
        name: '',
        email: 'session-owner@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    await ctx.internalAdapter.createSession(created.id, undefined)

    // Better Auth が書いた行を、アプリ側の経路（Drizzle）から読めること。
    // 片方だけで読めても意味がないので、両方から見る
    const rows = await testDb().select({ userId: session.userId }).from(session)

    expect(rows).toEqual([{ userId: created.id }])
  })

  it('利用者を消すとセッションも消える（外部キーの cascade）', async () => {
    const db = testDb()
    const ctx = await testAuth().$context

    const created = await ctx.adapter.create<UserRow>({
      model: 'user',
      data: {
        name: '',
        email: 'cascade@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    await ctx.internalAdapter.createSession(created.id, undefined)

    await db.delete(user)

    expect(await db.select().from(session)).toEqual([])
  })
})
