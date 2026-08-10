import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 取り入れ面に出してよいかの判定を貯める（#253 / 親 #252）。
 *
 * 🔴 **プールの実体ではない。キャッシュ。**
 * プール（#254）は毎日この表を引いて作り直す。ここに古い行が残っていても
 * **害が無い**（プールに出ない本文の判定が読まれないだけ）。
 *
 * 🔴 **元の本文をキーにする。** 同じ本文に2回 AI を使わないため。
 * 本文が書き換えられたら、新しい本文が別の行として増えるだけ。
 *
 * ⚠️ **`items` への外部キーを張らない。**
 * 項目が消えても判定は残ってよい（また同じことを書く人がいる）。
 * 張ると、項目を消すたびに判定を取り直すことになって AI の呼び出しが無駄に増える。
 */
export const wishTexts = sqliteTable(
  'wish_texts',
  {
    /** 正規化した元の本文（`normalizePoolText`）。 */
    normalized: text('normalized').primaryKey(),

    /**
     * 出してよいか。**`'ok'` か `'ng'`。**
     *
     * 🔴 **理由を持たない**（2026-08-10 の判断）。本人に伝えないと決めたので、
     * 持っても読む先が無い。持つと「なぜ落ちたか」を答える義務が生まれる。
     */
    verdict: text('verdict').notNull(),

    /** 代表表現。**名寄せの単位。** `ng` のときは null。 */
    canonical: text('canonical'),

    /** ジャンル（`GENRES` のスラッグ）。`ng` のときは null。 */
    genre: text('genre'),

    checkedAt: integer('checked_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    // プールを作るとき、代表表現でまとめて数える（#254）
    index('wish_texts_canonical_idx').on(table.canonical),
  ],
)
