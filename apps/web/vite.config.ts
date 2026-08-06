import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * `vite dev` 一発で **Worker と SPA の両方**が動く。
 *
 * Worker のコードは Vite の中で workerd で実行されるため、`wrangler dev` と同じ
 * ランタイムで確認できる。SPA は HMR が効く。起動するプロセスは1つ。
 *
 * バインディング（D1 など）は wrangler.jsonc から読まれる。
 */
export default defineConfig({
  plugins: [react(), cloudflare()],
})
