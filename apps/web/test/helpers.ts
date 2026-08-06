import { env } from 'cloudflare:workers'

import { type Auth, createAuth } from '../src/auth'
import { createDb, type Db } from '../src/db'
import { users } from '../src/db/schema'

/**
 * テスト用の Drizzle クライアント。
 *
 * 本体と同じ `createDb` を通す。テスト専用の接続経路を作ると、
 * 「テストは通るが本番の経路では動かない」状態が起きうる。
 */
export function testDb(): Db {
  return createDb(env.DB)
}

/**
 * すべてのテーブルの行を消す。`test/setup.ts` の `beforeEach` から呼ばれる。
 *
 * テーブル名を列挙せず `sqlite_master` から引くので、**テーブルを増やしても
 * ここを直す必要がない**（消し忘れたテーブルのデータが次のテストに漏れない）。
 *
 * 削除は `sqlite_master` の作成順の逆で行うが、**順序に頼って成立しているわけではない。**
 * 実際の削除順は `verifications` → `users` → `sessions` → `accounts` → `lists` で、
 * 親（`users`）が子（`sessions` / `lists`）より先に消えている。
 * それでも壊れないのは、**子の外部キーがすべて `on delete cascade` だから。**
 *
 * ⚠️ `on delete restrict` や `no action` の外部キーを持つテーブルを足したら、
 * ここは順序を考える必要が出る。**D1 は外部キーを実際に強制する**
 * （`FOREIGN KEY constraint failed` が出ることを `test/lists.test.ts` で確認済み）。
 */
export async function resetDb(): Promise<void> {
  const { results } = await env.DB.prepare(
    `select name from sqlite_master
     where type = 'table'
       and name not like 'sqlite_%'
       and name not like '_cf_%'
       and name != 'd1_migrations'
     order by rowid desc`,
  ).all<{ name: string }>()

  if (results.length === 0) return

  // batch は1トランザクションで実行される
  await env.DB.batch(results.map(({ name }) => env.DB.prepare(`delete from "${name}"`)))
}

/**
 * テスト用の Better Auth インスタンス。
 *
 * 本体と同じ `createAuth` を通す。鍵はテスト専用の固定値で、
 * `.dev.vars` や本番のシークレットには依存しない（CI でも同じ値で動く）。
 */
export function testAuth(): Auth {
  return createAuth(testDb(), {
    BETTER_AUTH_SECRET: 'test-secret-not-used-outside-tests-0123456789',
    BETTER_AUTH_URL: 'https://example.com',
  })
}

/**
 * テスト用の利用者を1人作り、その id を返す。
 *
 * `lists.user_id` は NOT NULL で `users.id` を参照するため、
 * リストのテストでは先に所有者が必要になる。
 */
export async function createTestUser(email = 'owner@example.com'): Promise<string> {
  const id = crypto.randomUUID()

  await testDb().insert(users).values({
    id,
    // 名前は保存するが表示しない（PRODUCT_SPEC.md §3）。テストでは空でよい
    name: '',
    email,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  return id
}

/**
 * 認証済みセッションを作るヘルパはここに足す（#52 で認可のテストを書くときに必要）。
 */
