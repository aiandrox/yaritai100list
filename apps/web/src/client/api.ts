import { hc } from 'hono/client'

import type { AppType } from '../index'

/**
 * サーバーの型からクライアントを作る（Hono RPC）。
 *
 * `AppType` は **`import type` で読む。** `verbatimModuleSyntax` が有効なので
 * この import はビルド時に消え、**Worker のコードがブラウザのバンドルに入らない。**
 * `import { type AppType }` ではなく `import type { ... }` と書くこと。
 *
 * 同一オリジンで配信されるため、ベース URL は相対でよい（CORS の設定が要らない）。
 */
export const api = hc<AppType>('/')
