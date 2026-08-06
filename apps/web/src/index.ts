import * as Sentry from '@sentry/cloudflare'
import { Hono } from 'hono'

import { createDb } from './db'
import { lists } from './db/schema'
import { sentryOptions } from './sentry'

/**
 * Hono に渡す環境。`Env` は `npm run cf-typegen`（wrangler types）が
 * wrangler.jsonc のバインディングから生成する。
 *
 * バインディングを増やしたら cf-typegen を再実行して
 * worker-configuration.d.ts を更新する（typecheck の前に自動で走る）。
 */
export interface AppEnv {
  Bindings: Env
}

/**
 * ルートはコンストラクタから直接チェーンする。Hono RPC はメソッドチェーンの
 * 戻り値の型からクライアントの型を作るため、`app` を宣言してから別文で
 * `app.get(...)` を呼ぶと型に route の情報が乗らない（#17 で使う）。
 */
const app = new Hono<AppEnv>()
  .get('/api/health', (c) => c.json({ status: 'ok' } as const))

  // D1 への往復が通っているかだけを確認する。行の内容は返さない
  .get('/api/health/db', async (c) => {
    const db = createDb(c.env.DB)
    await db.select({ id: lists.id }).from(lists).limit(1)
    return c.json({ status: 'ok', db: 'ok' } as const)
  })

/**
 * Sentry で包んでからエクスポートする。未処理の例外がここで捕まる。
 *
 * `defineCloudflareOptions` + `instrument.server.ts` による自動計装もあるが、
 * **プラグインが暗黙に拾う形は採らない。** どこで初期化されているかがコードから
 * 追えなくなる（`TECH_STACK.md` §1 の「暗黙のルールが少ないか」）。
 *
 * `sentryOptions` は DSN が無ければ `undefined` を返し、SDK は初期化されない。
 */
export default Sentry.withSentry(sentryOptions, app)

/**
 * Hono RPC のクライアント用。包む前の `app` の型を使う。
 * `withSentry` の戻り値は元の型をそのまま返すが、意図を明示するためこちらを参照する。
 */
export type AppType = typeof app
