import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

import type { Db } from './db'
import * as schema from './db/schema'

/**
 * このモジュールが必要とする環境変数。
 *
 * `sentry.ts` と同じ理由でモジュール側に宣言している
 * （`wrangler types` の `Env` には `.dev.vars` 由来の値が入らず、CI で型が落ちる）。
 */
export interface AuthEnv {
  /**
   * セッションの署名に使う鍵。**シークレット**。
   *
   * Google の資格情報と違い**アプリ側で生成する値**なので、
   * 開発者が用意する必要はない（`openssl rand -base64 32` 等で作る）。
   * ローカルは `.dev.vars`、本番は `wrangler secret put`。
   */
  readonly BETTER_AUTH_SECRET: string

  /**
   * このアプリの公開 URL。OAuth のコールバックとリダイレクトの基点になる。
   *
   * **リクエストの Host ヘッダから導出しない。** Host は攻撃者が差し替えられるため、
   * 導出するとリダイレクト先を乗っ取られる余地が生まれる。
   * 秘密の値ではないので `wrangler.jsonc` の `vars` に置き、
   * ローカルは `.dev.vars` で上書きする。
   */
  readonly BETTER_AUTH_URL: string
}

/**
 * Better Auth のインスタンスを作る。**リクエストごとに作る。**
 *
 * Workers では D1 のバインディングがリクエストのスコープにしか無いため、
 * モジュールの読み込み時には作れない。
 *
 * ## バージョンを固定している理由
 *
 * **`better-auth` は `~1.6.26`（パッチのみ）で固定している。**
 * 1.7 の `getMigrations()` は `pragma_index_list` を使い、D1 の authorizer が
 * Worker バインディング経由の pragma テーブル値関数を拒否するため
 * `SQLITE_AUTH` で落ちる（[#10551](https://github.com/better-auth/better-auth/issues/10551)、未修正）。
 *
 * なお**このアプリはその経路を通らない。** マイグレーションは Better Auth ではなく
 * Drizzle + wrangler で当てているため `getMigrations()` を呼ばない。
 * それでも固定を続けるのは、1.7 が他の箇所で pragma を使っていないことを
 * 確認していないため。外す条件は `TECH_STACK.md` §12。
 */
export function createAuth(db: Db, env: AuthEnv) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,

    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema,
    }),

    // ソーシャルログインのプロバイダは #50 で足す
  })
}

export type Auth = ReturnType<typeof createAuth>
