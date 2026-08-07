import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * `vite dev` 一発で **Worker と SPA の両方**が動く。
 *
 * Worker のコードは Vite の中で workerd で実行されるため、`wrangler dev` と同じ
 * ランタイムで確認できる。SPA は HMR が効く。起動するプロセスは1つ。
 *
 * バインディング（D1 など）は wrangler.jsonc から読まれる。
 *
 * Tailwind CSS v4 は**設定ファイルを持たない**（`tailwind.config.js` は無い）。
 * プラグインを足して、エントリの CSS に `@import "tailwindcss"` を書くだけで効く。
 * テーマの拡張が要るときは CSS 側の `@theme` に書く（`src/client/index.css`）。
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
})
