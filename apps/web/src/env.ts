import type { InferSelectModel } from 'drizzle-orm'

import type { AuthEnv } from './auth'
import type { lists } from './db/schema'
import type { SentryEnv } from './sentry'

/**
 * Hono に渡す環境。ミドルウェアとハンドラの両方から参照するため、
 * `index.ts` ではなくここに置いている（循環 import を避ける）。
 *
 * `Env` は `npm run cf-typegen`（wrangler types）が wrangler.jsonc の
 * バインディングから生成する。バインディングを増やしたら cf-typegen を再実行する
 * （typecheck の前に自動で走る）。
 *
 * `AuthEnv` と `SentryEnv` を交差させているのは、**シークレットが `Env` に入らない**ため。
 * `wrangler types` は `.dev.vars` から型を作るが、それは gitignore されていて CI に無い。
 * **このアプリが動くために必要な環境変数の一覧**がここに集まる形になっている。
 */
export interface AppEnv {
  Bindings: Env & AuthEnv & SentryEnv

  Variables: {
    /** `requireUser` が入れる。ログイン中の利用者の id */
    userId: string

    /**
     * `requireOwnedList` が入れる。**すでに所有者チェックを通ったリスト。**
     *
     * ハンドラは `listId` ではなくこれを受け取る。
     * ミドルウェアを付け忘れたハンドラには触れるリストが無い、という構造にしている。
     */
    list: InferSelectModel<typeof lists>
  }
}
