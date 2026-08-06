import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Better Auth が使うテーブル。
 *
 * **列は Better Auth 1.6.26 の定義から機械的に写した**（`getAuthTables({})` の出力）。
 * CLI（`@better-auth/cli`）は 1.4 系しか出ておらず本体とバージョンがずれているため使わない。
 * **Better Auth を上げるときは、同じ方法で列の差分を確認する:**
 *
 * ```sh
 * node --input-type=module -e "
 *   const { getAuthTables } = await import('./node_modules/better-auth/dist/db/index.mjs')
 *   console.log(JSON.stringify(getAuthTables({}), null, 2))"
 * ```
 *
 * 命名の制約:
 * - **テーブル名は `user` / `session` / `account` / `verification` から変えない。**
 *   Better Auth 側の既定値で、変えるなら設定でも合わせる必要がある
 * - **プロパティ名（`emailVerified` など）も変えない。** アダプタがこの名前で列を引く。
 *   DB 側の列名は snake_case にしている
 */

/**
 * 利用者。
 *
 * **`name` と `email` は保存するが、画面には出さない**（`PRODUCT_SPEC.md` §3）。
 * どの公開面にも作者を表示しないため、表示に使う場所は無い。
 * Sentry にも送らない（送るのは `id` だけ。`src/sentry.ts`）。
 */
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * セッション。**ストアは D1 のみ**（KV の `secondaryStorage` は使わない。`TECH_STACK.md` §8）。
 *
 * DB に持つので**サーバー側から失効させられる**。これは `CLAUDE.md` の不変条件。
 */
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * 外部プロバイダとの紐付け。Google のアカウント1つに対して1行。
 *
 * ⚠️ `accessToken` / `refreshToken` / `idToken` の列を持つ。
 * このアプリは**ログインにしか Google を使わない**ので、これらを保存する必要はない。
 * 保存するかどうかは #50（Google プロバイダの設定）で判断する。
 */
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * メール確認などの一時的なトークン。
 * ソーシャルログインだけなら使われないが、Better Auth が存在を前提にする。
 */
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})
