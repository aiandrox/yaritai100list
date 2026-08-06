import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * リスト。
 *
 * ここで持たない列と、それを足すイシュー:
 * - `user_id`: 認証のテーブルがまだ無いため #3 で足す
 * - `share_id`: 公開用の ID。#7（リストの共有）で足す
 *
 * 決めた仕様はできる限り DB の制約にする。人間がレビューしない開発では
 * 「間違っても DB が止めてくれる」ことが安全側の資産になる（TECH_STACK.md §7）。
 */
export const lists = sqliteTable(
  'lists',
  {
    /**
     * 編集用の ID。**推測不可能な値**を入れる。連番にしない（CLAUDE.md の不変条件）。
     * 公開用の `share_id` とは別の値にする。
     */
    id: text('id').primaryKey(),

    title: text('title').notNull(),

    /** 公開範囲。**既定は非公開**（PRODUCT_SPEC.md §5.1。旧実装は既定公開だった） */
    visibility: text('visibility', { enum: ['private', 'unlisted', 'public'] })
      .notNull()
      .default('private'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),

    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    // enum は Drizzle の型の上だけの話なので、DB 側にも制約を置く
    check('lists_visibility_check', sql`${t.visibility} in ('private', 'unlisted', 'public')`),
  ],
)
