import {
  type CompletedPrecision,
  EXPORT_IMAGE_SIGNATURE_HEADER,
  EXPORT_IMAGE_SIGNATURE_TTL_SECONDS,
  type ExportImagePayload,
  isCompleted,
} from '@yaritai100list/shared'

/**
 * 画像出力の入口（#192）。**認可はここで済ませる。**
 *
 * 🔴 **生成サービスに認可を判断させない**（`CLAUDE.md` の不変条件）。
 * `requireOwnedList` を通した行だけを署名して渡す。
 *
 * OGP（`og.ts`）との違いは**運び方だけ**。あちらは GET のクエリ、こちらは POST の本文
 * （100項目は URL に載らない。#189）。
 */

/**
 * 画像に描くデータを組み立てる。**純関数**（`TECH_STACK.md` §10）。
 *
 * 渡すのは**タイトルと項目だけ。** 作者も完了日時も入れない
 * （`PRODUCT_SPEC.md` §5.1 / §5.3。そもそも `ExportImagePayload` に入れる場所が無い）。
 */
export function buildExportImagePayload(
  list: { title: string },
  items: { text: string; completedPrecision: CompletedPrecision | null }[],
  now: Date,
): ExportImagePayload {
  return {
    title: list.title,
    // 🔴 **粒度で判定する**（#279）。`completedAt` で見ると
    // 日付なしの完了（粒度 `unknown`）が画像の上で未完了になる
    items: items.map((item) => ({
      text: item.text,
      completed: isCompleted(item.completedPrecision),
    })),
    exp: Math.floor(now.getTime() / 1000) + EXPORT_IMAGE_SIGNATURE_TTL_SECONDS,
  }
}

/**
 * 生成サービスへの問い合わせ。**POST で、署名はヘッダに載せる。**
 *
 * `Request` を組み立てて返すのは、**中身をテストで見られるようにするため**
 * （`fetch` の中で組み立てると、何を送っているか確かめられない）。
 */
export function exportImageRequest(
  base: string,
  payload: ExportImagePayload,
  signature: string,
): Request {
  return new Request(`${base.replace(/\/$/, '')}/export`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [EXPORT_IMAGE_SIGNATURE_HEADER]: signature,
    },
    body: JSON.stringify(payload),
  })
}

/**
 * ダウンロードするときのファイル名。
 *
 * ⚠️ **ASCII だけにする。** `content-disposition` に日本語をそのまま書くと文字化けする。
 * 見せる名前はクライアント側で付ける（#193）。ここは直接開かれたときの保険。
 */
export const EXPORT_IMAGE_FILE_NAME = 'yaritai100list.png'
