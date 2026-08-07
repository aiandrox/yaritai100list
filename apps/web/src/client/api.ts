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
 *
 * **いまは画面から呼んでいない**（未ログインのリストは localStorage だけで完結するため）。
 * サーバーへの保存を始める #5 で使う。消さないこと。
 */
export const api = hc<AppType>('/')
