import { VISIBILITIES } from '@yaritai100list/shared'
import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { users } from './auth'

/**
 * リスト。
 *
 * ここで持たない列と、それを足すイシュー:
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

    /**
     * 所有者。**NOT NULL。持ち主のいないリストは DB に存在しない。**
     *
     * 未ログインのリストはブラウザの localStorage にあり、DB には来ない
     * （`PRODUCT_SPEC.md` §2）。つまり DB の行は必ず誰かのもの。
     *
     * 利用者を削除したらリストも消える（`on delete cascade`）。
     * 消し残しがあると、持ち主のいない行が公開面に出る事故につながる。
     */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    title: text('title').notNull(),

    /**
     * 公開範囲。**既定は非公開**。公開は明示的な操作でのみ起きる（PRODUCT_SPEC.md §5.1）。
     * 取りうる値は packages/shared の `VISIBILITIES` が唯一の情報源。
     */
    visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('private'),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),

    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    // Drizzle の enum は型の上だけの話なので、DB 側にも制約を置く。
    // 値は VISIBILITIES から組み立てるので、公開範囲を増やしたときに
    // 型と DB 制約がずれない（sql.raw に渡すのは自分たちが定義したリテラルのみ）
    check(
      'lists_visibility_check',
      sql`${t.visibility} in (${sql.raw(VISIBILITIES.map((v) => `'${v}'`).join(', '))})`,
    ),
  ],
)
