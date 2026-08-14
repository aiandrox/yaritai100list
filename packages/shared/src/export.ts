import { z } from 'zod'

import {
  type CompletedPrecision,
  completedPrecisionSchema,
  formatCompletedOn,
  isCompleted,
} from './completion'
import { ITEMS_PER_LIST_MAX } from './limits'
import { isFutureCompletedAt, itemTextSchema, listTitleSchema } from './validation'

/**
 * リストを持ち出すときの形式（#115）。
 *
 * 目的は**リストの引き継ぎ**。別のアカウントへ移す、取っておく、の2つ。
 * **1ファイル = 1リスト。** アカウント丸ごとではない。
 *
 * 単位を1リストにしているのは:
 *
 * - **読み込みが常に「1つ作る」だけ**になり、上限の扱いが既存の取り込みと同じになる
 *   （「一部だけ入って残りが入らない」という状態が起きない）
 * - **マークダウンでの書き出し（#124）と単位が揃う**
 *
 * ⚠️ **形式はこれだけではない。** ブログへの転載用のマークダウン（#124、`buildMarkdown`）もある。
 * あちらは**人が読むためのもので読み込まない**。この JSON は「読み込める形式」の方。
 */

/**
 * 形式の版。**読めない版は断る**（#122）。
 *
 * 形を変えるときは上げる。上げたら、**古い版を読む経路を残すか、
 * 読めないと伝えるか**を決めること。黙って壊れた読み方をしない。
 */
export const EXPORT_VERSION = 1

/**
 * 書き出す項目。
 *
 * 🔴 **完了日時を含める。** `POST /api/lists/import`（localStorage からの引き継ぎ）が
 * 完了日時を受け取らないのとは**逆の判断**。あちらは未ログインで印を付けられない
 * という制約（#77）を守るためだが、こちらは**「いつ叶えたか」を落とすと
 * 持ち出す意味が無くなる**（`PRODUCT_SPEC.md` §3 が完了を真偽値にしなかった理由）。
 *
 * そのぶん**読み込みの経路を分ける**。#89 の「完了日時はサーバーが決める」の
 * 例外になるので、既存の取り込みに混ぜない。
 */
export const exportedItemSchema = z
  .object({
    text: itemTextSchema,
    /** 完了日時（ISO 8601）。未完了と**日付なしの完了**（#279）なら `null` */
    completedAt: z.iso.datetime().nullable(),

    /**
     * 完了の粒度（#279）。未完了なら `null`。
     *
     * 🔴 **省略できる。版（`EXPORT_VERSION`）を上げていない**（2026-08-14 の判断）。
     * 上げると、**粒度を持たない既存のファイルが読めなくなる**（版が違えば断る作り）。
     * 足したのは省略可能な1項目だけで、**古いファイルの意味は変わらない**
     * （`completed_at` があれば `day`。`completedPrecisionOf` が補う）ので、
     * 版で断る理由が無い。
     */
    completedPrecision: completedPrecisionSchema.nullable().optional(),
  })
  .strict()
  /**
   * 🔴 **粒度と完了日時の食い違いを読み込まない**（#279）。
   * ファイルは手で編集できる。`day` なのに日時が無い行を通すと、
   * DB のトリガー（`0016`）に弾かれて 500 になる。**入口で断る。**
   */
  .refine(
    (item) =>
      item.completedPrecision === undefined ||
      (item.completedPrecision === null || item.completedPrecision === 'unknown'
        ? item.completedAt === null
        : item.completedAt !== null),
    { message: '完了の粒度と完了日時が合っていない' },
  )

export type ExportedItem = z.infer<typeof exportedItemSchema>

/**
 * 書き出された項目の粒度（#279）。**古いファイルを読むための補い。**
 *
 * 粒度が無いファイル（#279 より前に書き出したもの）は、
 * **完了日時があれば `day`、無ければ未完了**。これは #279 のマイグレーションと同じ規則。
 */
export function completedPrecisionOf(item: ExportedItem): CompletedPrecision | null {
  if (item.completedPrecision !== undefined) return item.completedPrecision

  return item.completedAt === null ? null : 'day'
}

export const exportedListSchema = z
  .object({
    title: listTitleSchema,
    items: z.array(exportedItemSchema).max(ITEMS_PER_LIST_MAX),
  })
  .strict()

export const exportFileSchema = z
  .object({
    version: z.literal(EXPORT_VERSION),
    /** 書き出した時刻。中身の判断には使わない（人が見分けるための情報） */
    exportedAt: z.iso.datetime(),
    list: exportedListSchema,
  })
  .strict()

export type ExportFile = z.infer<typeof exportFileSchema>

/**
 * 書き出す内容を組み立てる。**純関数**（`TECH_STACK.md` §10）。
 *
 * 項目は**渡された順のまま**。並べ替えない（並び順の情報源は呼び出し側の1箇所）。
 */
export function buildExportFile(
  list: {
    title: string
    items: {
      text: string
      completedAt: Date | null
      completedPrecision: CompletedPrecision | null
    }[]
  },
  exportedAt: Date,
): ExportFile {
  return {
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    list: {
      title: list.title,
      items: list.items.map((item) => ({
        text: item.text,
        completedAt: item.completedAt === null ? null : item.completedAt.toISOString(),
        // 🔴 **粒度も書き出す**（#279）。落とすと、日付なしの完了が
        // **読み込んだ先で未完了になる**（`completed_at` が無いため）
        completedPrecision: item.completedPrecision,
      })),
    },
  }
}

/**
 * 完了日時に**未来のものが混ざっていないか**。
 *
 * 🔴 読み込みは「完了日時はサーバーが決める」（#89）の例外なので、
 * **最低限ここだけは見る。** ファイルは手で編集できるし、書き出した端末の時計が
 * 狂っていることもある。未来の日時が入ると「まだ来ていない日に叶えた」ことになる。
 *
 * 判定そのものは `isFutureCompletedAt`。**完了日時の直し（#207）と同じものを使う。**
 * 「どこまで許すか」を2箇所に書くと必ずずれる。
 */
export function hasFutureCompletedAt(file: ExportFile, now: Date): boolean {
  return file.list.items.some(
    (item) => item.completedAt !== null && isFutureCompletedAt(new Date(item.completedAt), now),
  )
}

/**
 * 書き出すファイルの名前。
 *
 * **日付を入れる。** 同じリストを何度も書き出したときに上書きされず、
 * どれが新しいか分かる。
 *
 * ファイル名に使えない文字（`/` や `\`、制御文字など）はリスト名に入りうるので落とす。
 * 落とした結果が空になることもある（記号だけのタイトル）ので、そのときは既定の名前にする。
 */
export function exportFileName(
  title: string,
  exportedAt: Date,
  extension: 'json' | 'png' = 'json',
): string {
  const date = exportedAt.toISOString().slice(0, 10)

  // 経路の区切りと、OS がファイル名に使えない文字だけを落とす。
  // 落としすぎると何のリストか分からなくなるので、日本語や記号は残す
  const safe = title.replace(/[/\\:*?"<>|]/g, '').trim()

  return `${safe === '' ? 'list' : safe}-${date}.${extension}`
}

/**
 * マークダウンの行の形（#209）。
 *
 * - `checklist`: `- [x] グランピング`。GitHub / Zenn / Qiita ではチェックボックスになる
 * - `numbered`: `1. グランピング`。番号を振りたい転載先向け
 */
export type MarkdownStyle = 'checklist' | 'numbered'

export interface MarkdownOptions {
  style: MarkdownStyle
  /** 達成日を行に出すか。**出さなくても「完了かどうか」は消さない**（`buildMarkdown`） */
  showCompletedDate: boolean
}

/**
 * 既定は **#124 で決めた出力そのまま**（チェックリスト・達成日あり）。
 *
 * #209 で選べるようにしたが、**決定を覆したわけではない。**
 * 何も選ばなかった人には、これまでと1文字も変わらないものが出る。
 */
export const DEFAULT_MARKDOWN_OPTIONS: MarkdownOptions = {
  style: 'checklist',
  showCompletedDate: true,
}

/**
 * マークダウンで書き出す（#124）。**ブログなどへの転載用。**
 *
 * 🔴 **これは読み込まない。人が読むためのもの。**
 * 往復させたいなら JSON（`buildExportFile`）を使う。
 *
 * 決めたこと（2026-08-08、#124）:
 *
 * - **見出しは `##`。** 転載先の記事にはすでに記事タイトル（`#`）があることが多い。
 *   独立した文書として見ると `#` が正しいが、**貼る側が下げるより、貼られる側に合わせる**
 * - **既定はチェックリスト（`- [x]`）で完了を表す。** GitHub / Zenn / Qiita では
 *   チェックボックスとして描かれ、対応していない場所でも文字として意味が通る
 * - **既定では番号を振らない**（#209 で選べるようにした）。未入力の枠を出さないので
 *   「001〜100」の連番という意味が薄れるし、転載先で番号がずれると直すのが面倒になる
 * - **未入力の枠は出さない。** 100行の空行は転載に向かない
 * - **既定では達成日を出す**（#209 で消せるようにした）。消すのは簡単だが、
 *   **出さなかったものは後から足せない。**
 *   「いつ叶えたか」はこのアプリが真偽値にしなかった理由そのもの（`PRODUCT_SPEC.md` §3）
 * - 🔴 **数字は「達成済み / 入力済み」**（2026-08-08、#129）。
 *   **画面の「23 / 100」（埋まり具合）とは意図が違う。揃えない。**
 *   画面は「まだ埋まっていない」という動機を出すためのものだが、
 *   転載を読む人が知りたいのは**どれだけ叶えたか**。分母も 100 ではなく
 *   **実際に書いた数**にする（書いていない枠を数に入れても意味がない）
 *
 * 🔴 **日付の整形を外から受け取らない**（2026-08-14、#279）。
 * 以前はブラウザの時間帯で整形したものを渡していたが、**完了日は日本時間の暦日**
 * として扱うことにしたので（`COMPLETED_ON_TIME_ZONE_OFFSET_MS`）、
 * ここも画面・共有ページと同じ `formatCompletedOn` を使う。
 * **同じ完了日が、どこで見ても同じ文字列で出る**方を採った。
 */
export function buildMarkdown(
  file: ExportFile,
  options: MarkdownOptions = DEFAULT_MARKDOWN_OPTIONS,
): string {
  // 🔴 **粒度で数える**（#279）。`completedAt` で数えると日付なしの完了が落ちる
  const completed = file.list.items.filter((item) => isCompleted(completedPrecisionOf(item))).length

  // 数の行は形式で変えない。**どの形式でも「どれだけ叶えたか」は同じ情報**（#129）
  const lines = [
    `## ${file.list.title}`,
    '',
    `${String(completed)} / ${String(file.list.items.length)} 達成済み`,
    '',
  ]

  file.list.items.forEach((item, index) => {
    lines.push(`${mark(item, index)} ${item.text}${suffix(item)}`)
  })

  // 末尾を改行で終える。貼り付けた先で次の行とくっつかない
  return `${lines.join('\n')}\n`

  /**
   * 行の頭。
   *
   * 連番は**1から通しで振る**（未完了も数える）。画面の `001` とはずれるが、
   * あちらは100枠の中の位置で、こちらは**書いたものの中の位置**。揃える意味が無い。
   */
  function mark(item: ExportedItem, index: number): string {
    if (options.style === 'numbered') return `${String(index + 1)}.`

    return isCompleted(completedPrecisionOf(item)) ? '- [x]' : '- [ ]'
  }

  function suffix(item: ExportedItem): string {
    const precision = completedPrecisionOf(item)
    if (!isCompleted(precision)) return ''

    /**
     * 粒度どおりに出す（#279）。`2026/08/14` / `2026年8月` / `2026年`。
     *
     * 🔴 **日付なしの完了では空になる。** そのときは下の「印を残す」に落ちる
     * （`- [x]` があるチェックリストでは何も足さない、という #279 の判断）。
     */
    const date =
      item.completedAt === null ? '' : formatCompletedOn(new Date(item.completedAt), precision)

    if (options.showCompletedDate && date !== '') return `（${date} 達成）`

    // 🔴 **連番のときだけ、日付が無くても完了の印を残す。**
    // 連番には `- [x]` にあたるものが無いので、日付まで消すと
    // **完了かどうかを表す手段が行から全部無くなる**（#209）
    return options.style === 'numbered' ? '（達成済）' : ''
  }
}
