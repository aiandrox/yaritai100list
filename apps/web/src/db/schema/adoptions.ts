import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

import { items } from './items'

/**
 * 取り入れの記録（#233 / 親 #10）。
 *
 * 🔴 **`items` の列にしない**（2026-08-07 の判断。`items.ts` の先頭コメント）。
 * 取り入れは本文をコピーする操作で、**コピー後に本文を書き換えたら関係は切れる。**
 * 別の表なら関係を**足す / 消す**だけで表現でき、`items` の更新は本文を書くだけで済む。
 *
 * 🔴 **取り入れ元を「項目」ではなく「本文」で持つ**（2026-08-09 の利用者の判断）。
 * プールの単位が本文だから（同じ本文を3人が書いていても、プールには1行しか出さない）。
 *
 * **この形にすると、決めなければいけないと思っていた2つが消える:**
 *
 * - 取り入れ元の項目やリストが消えたとき → **何も起きない。** 指していないため
 * - 取り入れ元が非公開に変わったとき → **プールから消えるだけ。** 記録は残る
 *
 * ⚠️ **人気指標を数えるのはこの表だけ。** 未ログインの取り入れは数えない（#236）。
 * 数えるには認証なしで書き込める口が要り、水増しできてしまう。
 */
export const adoptions = sqliteTable(
  'adoptions',
  {
    id: text('id').primaryKey(),

    /**
     * 取り入れてできた**自分の項目**。
     *
     * 🔴 **一意。** 1つの項目に取り入れ元は1つしかない。
     * 2行入ると同じ項目が2回数えられる。
     *
     * 🔴 **`on delete cascade`。** 取り入れた項目を消したら記録も消す。
     * 残すと「もう存在しない取り入れ」が人気指標に効き続け、**数字が実態から離れる。**
     */
    adopterItemId: text('adopter_item_id')
      .notNull()
      .unique()
      .references(() => items.id, { onDelete: 'cascade' }),

    /**
     * 取り入れた本文。**外部キーではない**（上のコメント）。
     *
     * ⚠️ **取り入れた時点の本文をそのまま持つ。**
     * 後で自分の項目の本文を書き換えても、ここは変わらない
     * （書き換えたときは行ごと消す。#234）。
     */
    sourceText: text('source_text').notNull(),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    // プールの並び順を出すたびに本文で数えるので、索引が要る
    index('adoptions_source_text').on(table.sourceText),
  ],
)
