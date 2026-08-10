import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 取り入れ面に出してよいかの判定を貯める（#253 / 親 #252）。
 *
 * 🔴 **プールの実体ではない。キャッシュ。**
 * プール（#254）は毎日この表を引いて作り直す。ここに古い行が残っていても
 * **害が無い**（プールに出ない本文の判定が読まれないだけ）。
 *
 * 🔴 **書かれたままの本文をキーにする。** 同じ本文に2回 AI を使わないため。
 * 本文が書き換えられたら、新しい本文が別の行として増えるだけ
 * （**書き換えない限り再判定は要らない**。2026-08-10 の判断）。
 *
 * ⚠️ **`items` への外部キーを張らない。**
 * 項目が消えても判定は残ってよい（また同じことを書く人がいる）。
 * 張ると、項目を消すたびに判定を取り直すことになって AI の呼び出しが無駄に増える。
 */
export const wishTexts = sqliteTable(
  'wish_texts',
  {
    /**
     * **書かれたままの本文**（`items.text` と同じ値）。
     *
     * 🔴 **正規化した形をキーにしない。** そうすると
     * 「まだ判定していない本文」を SQL だけで絞れなくなり、
     * **毎回すべての公開項目を JS に読み込んで正規化する**ことになる。
     * 定期実行の CPU は Free で 10ms しかないので、項目が増えると破綻する。
     *
     * ⚠️ 引き換えに、`ＹｏｕＴｕｂｅ` と `YouTube` は**別の行になり、AI を2回呼ぶ。**
     * ただし**どちらも同じ代表表現に落ちる**ので、プールでは1つにまとまる。
     * 表記ゆれは珍しく、costs は代表表現が吸収する。
     */
    rawText: text('raw_text').primaryKey(),

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

    /** いつ判定したか。**再判定には使わない**（本文が変われば別の行になるため）。調べるとき用。 */
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (table) => [
    // プールを作るとき、代表表現でまとめて数える（#254）
    index('wish_texts_canonical_idx').on(table.canonical),
  ],
)
