import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { users } from './auth'

/**
 * 規約とポリシーへの同意の記録（#319）。
 *
 * 🔴 **いまは誰も書かない**（2026-09-01、#331）。
 * 明示同意のモーダルはやめて、**規約の前文（«利用した時点で同意したものとみなす»）**
 * に一本化した。**この表を読み書きするコードは無い。**
 *
 * 残してあるのは、**規約を改定したときに «変わったこと» を伝える仕組み**を
 * 作るときの土台にするため。作らないと決めたら、**表ごと落としてよい。**
 */

/**
 * （もとの設計メモ）
 *
 * 🔴 **`users` の列にしない**（2026-09-01 の利用者の指示）。理由は2つ。
 *
 * - **版ごとに1行ずつ積む。** 規約を改定したときに、
 *   **どの版にいつ同意したか**が全部残る。列だと最後の1つしか持てない
 * - **`users` は Better Auth のアダプタが読み書きする表**（`auth.ts` の注意書き）。
 *   こちらの都合で列を足さない
 *
 * ⚠️ **同意していないことは「行が無い」で表す。**
 * 「同意しなかった」を記録しない（断った人はログアウトするので、次に来たらまた聞く）。
 */
export const agreements = sqliteTable(
  'agreements',
  {
    /** 推測不可能な値。**連番にしない**（`CLAUDE.md` の不変条件）。 */
    id: text('id').primaryKey(),

    /**
     * 同意した人。
     *
     * 🔴 **アカウントを消したら同意の記録も消える**（`on delete cascade`）。
     * これも本人に紐づく情報なので、`lists` と同じ扱いにする（#308）。
     */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * 同意した規約の版。**`LEGAL_EFFECTIVE_DATE`（ISO の日付）と同じ形。**
     *
     * 🔴 **突き合わせるので ISO で持つ。**「いまの版の行があるか」だけを見る
     * （`2026年8月21日` のような表示用の文字列だと比べられない）。
     */
    effectiveOn: text('effective_on').notNull(),

    agreedAt: integer('agreed_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    // 引くのは必ず「この人が、この版に同意しているか」
    index('agreements_user_id_effective_on_idx').on(t.userId, t.effectiveOn),
  ],
)
