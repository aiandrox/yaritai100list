import { env } from 'cloudflare:workers'
import { makeSignature } from 'better-auth/crypto'

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
    BETTER_AUTH_SECRET: workerEnv('BETTER_AUTH_SECRET'),
    BETTER_AUTH_URL: testBaseUrl(),
  })
}

/**
 * テストのリクエストに使うオリジン。**Worker の `BETTER_AUTH_URL` と揃える。**
 *
 * ずれると2つの理由で認証が通らない:
 * - **Cookie 名が変わる。** https なら `__Secure-` 接頭辞が付き、http なら付かない
 * - Better Auth の Origin チェックに引っかかる
 */
export function testBaseUrl(): string {
  return workerEnv('BETTER_AUTH_URL')
}

/**
 * 🔴 **Worker が実際に使っている環境変数を読む。テスト側に固定値を書かない。**
 *
 * `wrangler` は `.dev.vars` を読み、**その値が vitest の `miniflare.bindings` を上書きする。**
 * つまり手元では `.dev.vars`、CI では `miniflare.bindings` の値が使われる。
 * テスト側に固定値を書くと、**手元だけ、あるいは CI だけ落ちる。**
 *
 * `Env` の型には入らない（`.dev.vars` は gitignore されていて CI に無いため）ので、
 * ここで narrow する。
 */
function workerEnv(name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name]

  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} がテスト環境に無い。vitest.config.ts を確認する`)
  }

  return value
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
 * 利用者を作り、**認証済みリクエスト用の Headers** を返す。
 *
 * Better Auth のセッション Cookie は**署名付き**なので手では作れない。
 * 署名の作り方は better-auth 自身のテストユーティリティ
 * （`dist/plugins/test-utils/cookie-builder.mjs`）と同じ:
 *
 * ```
 * signCookieValue(value, secret) => `${value}.${await makeSignature(value, secret)}`
 * ```
 *
 * そのユーティリティは `exports` に公開されていないため deep import できない。
 * 依存している `makeSignature` は `better-auth/crypto` から公開されているので、
 * **1行だけ同じ実装を持つ。** Better Auth を上げるときは
 * cookie-builder.mjs の実装が変わっていないか確認する。
 */
export async function signIn(email = 'owner@example.com'): Promise<{
  userId: string
  headers: Headers
}> {
  const auth = testAuth()
  const ctx = await auth.$context

  const userId = await createTestUser(email)
  const session = await ctx.internalAdapter.createSession(userId, undefined)

  const signed = `${session.token}.${await makeSignature(session.token, ctx.secret)}`
  const headers = new Headers({
    cookie: `${ctx.authCookies.sessionToken.name}=${signed}`,
  })

  return { userId, headers }
}
