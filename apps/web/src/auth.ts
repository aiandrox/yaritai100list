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

  /**
   * Google の OAuth クライアント ID。
   *
   * **development と production で値が違う**（#1 でクライアントを2つに分けた）。
   * 「Client ID は公開値だから」と `wrangler.jsonc` に直書きすると、
   * ローカルで本番クライアントを使ってしまうため、環境変数で渡す。
   *
   * **未設定ならログイン手段が無くなるだけで、アプリは起動する**（下記）。
   */
  readonly GOOGLE_CLIENT_ID?: string

  /** Google の OAuth クライアントシークレット。**シークレット**。 */
  readonly GOOGLE_CLIENT_SECRET?: string
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

    /**
     * テーブル名を複数形に揃えている（Better Auth の既定は単数形）。
     *
     * 🔴 **`modelName` と Drizzle の export 名の両方を変える必要がある。**
     * Drizzle アダプタは**モデル名でスキーマのプロパティを引く**ため、
     * 片方だけ変えるとスキーマを解決できず、認証全体が落ちる。
     *
     * `fields`（列名の対応）は指定しない。Drizzle アダプタでは列名は
     * Drizzle 側の定義が使われるので、ここで書くと二重指定になる。
     */
    user: { modelName: 'users' },
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },
    // `session` の `modelName` は下の session オプションにまとめて指定している

    /**
     * **資格情報が揃っている環境だけで Google を有効にする。**
     *
     * 揃っていない環境（`.dev.vars` に入れていないローカル）でも
     * `npm run dev` が起動し、`/api/health` などは動く。ログイン手段が無くなるだけ。
     * `SENTRY_DSN` が無ければ通知を無効にするのと同じ考え方。
     */
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},

    session: {
      modelName: 'sessions',

      /**
       * 🔴 **Cookie キャッシュを使わない。**
       *
       * 有効にすると、セッションの内容が署名付き Cookie に載って
       * DB を見ずに認証が通る。つまり**サーバー側でセッションを消しても
       * キャッシュの有効期間は通り続ける。**
       * `CLAUDE.md` の「セッションはサーバー側から失効できる方式にする」に反する。
       *
       * 既定は無効だが、性能改善のつもりで有効にされると認可が静かに壊れるため
       * 明示的に書いておく。
       */
      cookieCache: { enabled: false },
    },

    advanced: {
      /**
       * 🔴 **Cookie に `Domain` 属性を付けない（host-only）。**
       *
       * `crossSubDomainCookies` を有効にすると `Domain` が付く。
       * `workers.dev` は**他人のワーカーとサブドメインを共有する空間**なので、
       * `Domain=workers.dev` のような Cookie は他のワーカーにも送られてしまう。
       * 既定は無効だが、これも明示しておく（`TECH_STACK.md` §8）。
       */
      crossSubDomainCookies: { enabled: false },

      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
      },

      // `Secure` は baseURL のプロトコルから決まる（本番は https なので付く）。
      // ローカルは http://localhost で、ブラウザは localhost を安全な文脈として扱う
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
