import { z } from 'zod'

import { ITEMS_PER_LIST_MAX } from './limits'
import { itemTextSchema, listTitleSchema } from './validation'

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
 * ⚠️ **形式はこれだけではない。** ブログへの転載用にマークダウンでも書き出す予定があり、
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
    /** 完了日時（ISO 8601）。未完了なら `null` */
    completedAt: z.iso.datetime().nullable(),
  })
  .strict()

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
  list: { title: string; items: { text: string; completedAt: Date | null }[] },
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
 * 過去は見ない。**いつ叶えたかは持ち主のもの**で、こちらが妥当性を決める話ではない。
 */
export function hasFutureCompletedAt(file: ExportFile, now: Date): boolean {
  return file.list.items.some(
    (item) => item.completedAt !== null && Date.parse(item.completedAt) > now.getTime(),
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
export function exportFileName(title: string, exportedAt: Date): string {
  const date = exportedAt.toISOString().slice(0, 10)

  // 経路の区切りと、OS がファイル名に使えない文字だけを落とす。
  // 落としすぎると何のリストか分からなくなるので、日本語や記号は残す
  const safe = title.replace(/[/\\:*?"<>|]/g, '').trim()

  return `${safe === '' ? 'list' : safe}-${date}.json`
}
