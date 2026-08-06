import { defineConfig } from 'drizzle-kit'

/**
 * マイグレーションの SQL を生成するための設定。
 *
 * 適用は drizzle-kit ではなく **wrangler** が行う（`npm run db:migrate`）。
 * D1 のローカル環境は wrangler が管理しているため、生成と適用でツールが分かれる。
 *
 * **生成するときは必ず名前を付ける**（付けないと `0001_wide_nomad.sql` のような
 * ランダムな名前になり、後から何の変更か分からなくなる）:
 *
 * ```sh
 * npm run db:generate --workspace @yaritai100list/web -- --name add_user_id
 * ```
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './migrations',
})
