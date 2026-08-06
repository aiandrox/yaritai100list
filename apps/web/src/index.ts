import { Hono } from 'hono'

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
const app = new Hono<AppEnv>().get('/api/health', (c) => c.json({ status: 'ok' } as const))

export default app

export type AppType = typeof app
