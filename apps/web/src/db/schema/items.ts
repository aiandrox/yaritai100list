import { COMPLETED_PRECISIONS } from '@yaritai100list/shared'
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { lists } from './lists'

/**
 * やりたいこと1件。
 *
 * 🔴 **取り入れ元（#10）をどこにも記録しない**（2026-08-10 利用者の判断）。
 * 当初はこの表の列にしない代わりに別の表を作ったが、その表ごとやめた。
 *
 * 取り入れ面の並びは「**その本文を書いている人が何人いるか**」で決める。
 * 取り入れると自分のリストにその本文の項目が1つ増えるので、
 * **取り入れはその数に自動的に現れる。** 別に数える必要が無い。
 *
 * これで「本文を書き換えたら関係を消す」という後始末も消えた。
 * 詳細はイシュー #10 のコメント。
 *
 * 決めた仕様はできる限り DB の制約にする。人間がレビューしない開発では
 * 「間違っても DB が止めてくれる」ことが安全側の資産になる（`TECH_STACK.md` §7）。
 * ただし**文字数と件数の上限は DB に書かない。** 上限の情報源は
 * `packages/shared` の Zod スキーマ1箇所（`CLAUDE.md` の不変条件）で、
 * SQL にも数字を書くと2箇所になる。`lists.title` に長さの制約が無いのと揃えている。
 */
export const items = sqliteTable(
  'items',
  {
    /**
     * 項目の ID。**推測不可能な値**を入れる。連番にしない（`CLAUDE.md` の不変条件）。
     *
     * 公開 URL には出ないが、`/api/lists/:listId/items/:itemId` の形で
     * 要求に載る。連番だと他人の項目の存在と件数が推測できてしまう。
     */
    id: text('id').primaryKey(),

    /**
     * 属するリスト。**NOT NULL。どのリストにも属さない項目は存在しない。**
     *
     * リストを消したら項目も消える（`on delete cascade`）。
     * 消し残すと、持ち主のいない項目が取り入れ面（#10）に出る事故につながる。
     */
    listId: text('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),

    text: text('text').notNull(),

    /**
     * 完了日時。**真偽値にしない**（`PRODUCT_SPEC.md` §3）。
     * いつ叶えたかは思い出として意味がある。
     *
     * 🔴 **これで完了を判定しない**（#279）。**日付を覚えていない完了**
     * （`completed_precision = 'unknown'`）は NULL のままなので、
     * 完了かどうかは `completed_precision` で見る（`isCompleted`）。
     *
     * `year` / `month` の粒度では**その期間の頭（日本時間）**が入る。
     * 2026年 なら 2026-01-01 00:00 JST（`parseCompletedOn`）。
     */
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),

    /**
     * 完了日の粒度（#279）。**NULL は未完了。**
     * 取りうる値は `packages/shared` の `COMPLETED_PRECISIONS` が唯一の情報源。
     *
     * 🔴 **`completed_at` との組み合わせは DB でも止める**（マイグレーション `0016`）。
     * `unknown` は日時を持たない・日付のある粒度は日時が必須・未完了はどちらも無し。
     *
     * ⚠️ **CHECK ではなくトリガーで書いてある。** SQLite は既存の表に
     * CHECK を後から足せず、表の作り直しが要る（`items` は外部キーと索引を持つ）。
     * `lists` の件数上限（`0006`）と同じ折り合い。
     */
    completedPrecision: text('completed_precision', { enum: COMPLETED_PRECISIONS }),

    /**
     * 共有ページで本文を伏せるか（#237）。**既定は伏せない。**
     *
     * 🔴 **リストの公開範囲（`lists.visibility`）とは別物。** あちらは「誰が見られるか」、
     * こちらは「見られる相手にこの1件の本文を見せるか」。項目単位で、共有ページにだけ効く
     * （ダウンロード画像・マークダウン書き出し・JSON書き出しには適用しない。#237 のコメント）。
     *
     * 隠しても番号・完了マーク・達成数へのカウントはそのまま出す。伏せるのは本文（と完了日時）だけ
     * （`src/share.ts` の `renderSharePage`）。取り入れ面のプール（`src/pool.ts`）からも除く。
     */
    hiddenInShare: integer('hidden_in_share', { mode: 'boolean' }).notNull().default(false),

    /**
     * リスト内の並び順。**0 から始まる詰まった連番**（`TECH_STACK.md` §7）。
     *
     * 表示上の番号（`001`〜）はこの順序から作る。番号を列として持たない
     * （2つ持つと必ずずれるし、ずれたときにどちらが正しいか決められない）。
     *
     * **一意制約は付けない。** 付けると入れ替えのたびに退避用の値が要る
     * （`0` と `1` を交換するのに一時的な `-1` が必要になる）。
     * 1リスト100件が上限なので、**並び替えは全件書き直しでよい。**
     */
    position: integer('position').notNull(),

    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),

    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch('subsec') * 1000)`),
  },
  (t) => [
    // 並び順に負の値が入らないようにする。アプリ側の計算間違いを DB で止める
    check('items_position_check', sql`${t.position} >= 0`),

    // 取得は必ず「あるリストの項目を並び順で」なので、この2列で引けるようにする
    index('items_list_id_position_idx').on(t.listId, t.position),

    /**
     * 取り入れ面のプール（#10）が**本文でまとめて数える**ため。
     *
     * `group by text` と「その本文を持つ人を数える」の両方でここを引く。
     * 索引が無いと、プールを開くたびに全項目を走査することになる。
     */
    index('items_text_idx').on(t.text),
  ],
)
