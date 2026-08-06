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
 * `accounts` の行から**使わない資格情報を落とす。**
 *
 * このアプリは Google を**ログインの手段としてしか使わない**（`PRODUCT_SPEC.md` §3）。
 * Google の API を呼ばないので、`accessToken` も `idToken` も使い道が無い。
 * 要求しているスコープは `openid` / `email` / `profile` だけなので漏れても被害は限定的だが、
 * **使わないものを持ち続ける理由が無い。**
 *
 * ⚠️ **Better Auth 1.6.26 に「保存しない」設定は無い。**
 * `updateAccountOnSignIn` は更新の可否を決めるだけで、初回の保存は止まらない。
 * そのため `databaseHooks` で列を `null` に潰す。
 *
 * `refreshToken` は offline access を要求していないので元から返らないが、
 * **将来スコープを増やしたときに黙って保存され始めない**よう、ここでも落としておく。
 * 期限の列も、対応するトークンが無ければ意味を持たないので一緒に落とす。
 */
export function withoutOAuthCredentials<T extends object>(account: T) {
  return {
    ...account,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  }
}

/**
 * `sessions` の行から**利用者を追跡できる情報を落とす。**
 *
 * Better Auth は既定でセッションに IP と User-Agent を保存する。
 * このアプリには**それを読む機能が無い**（ログイン履歴も端末一覧も作らない）。
 * 使わない個人情報を持たない。
 *
 * 🔴 **`advanced.ipAddress.disableIpTracking` は使わない。**
 * あれを立てると `getIp()` が `null` を返すようになり、**レート制限のキーからも IP が消える**
 * （`@better-auth/core/utils/ip.mjs` の先頭で分岐している）。
 * ここでやりたいのは「**保存しない**」であって「**取得しない**」ではない。
 * 濫用対策は残したまま、DB に書く直前で落とす。
 *
 * なお Better Auth 内蔵のレート制限は本番で既定有効だが、ストアが `memory` で
 * Workers では isolate ごとに分かれるため強くない。
 * 本命は Workers の `ratelimit` バインディング（`TECH_STACK.md` §9、#5 で入れる）。
 */
export function withoutClientMetadata<T extends object>(session: T) {
  return { ...session, ipAddress: null, userAgent: null }
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

    /**
     * DB に書く直前に内容を差し替える。**書き込みの経路は1つしかない**ので、
     * ここに置けばログイン・再ログインのどちらでも効く。
     *
     * `create` だけでは足りない。**2回目以降のログインは `update` を通る**ため
     * （`updateAccountOnSignIn` の既定が有効）、片方だけだとトークンが復活する。
     */
    databaseHooks: {
      account: {
        create: {
          before: (account) => Promise.resolve({ data: withoutOAuthCredentials(account) }),
        },
        update: {
          before: (account) => Promise.resolve({ data: withoutOAuthCredentials(account) }),
        },
      },

      session: {
        create: {
          before: (session) => Promise.resolve({ data: withoutClientMetadata(session) }),
        },
        update: {
          before: (session) => Promise.resolve({ data: withoutClientMetadata(session) }),
        },
      },
    },

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
