import { z } from 'zod'

import { signCanonical, verifyCanonical } from './hmac'
import { ITEM_TEXT_MAX_LENGTH, ITEMS_PER_LIST_MAX, LIST_TITLE_MAX_LENGTH } from './limits'

/**
 * 画像出力（#9）に渡すデータと、その署名（#189）。
 *
 * OGP（`og.ts`）と考え方は同じだが、**運び方が違う。**
 *
 * 🔴 **GET のクエリに載せられない。** 100項目 × 22文字 = 2,200文字。
 * 日本語は URL エンコードで 1 文字 9 バイトになるので **約 20KB** になり、
 * URL の実用上の上限（8KB 前後）を超える。**POST の本文に対して署名する。**
 *
 * 副作用として `/og` のような URL キャッシュが効かないが、
 * **画像出力は「押したときに1枚作る」もの**で、SNS が繰り返し取りに来る OGP とは性質が違う。
 */

/**
 * 画像に描く内容。**リストのタイトルと、やりたいこと全部**（`PRODUCT_SPEC.md` §5.3）。
 *
 * 🔴 **作者を入れない**（§5.1）。どの公開面にも出さない。
 * **入れる場所が無ければ、間違えて入れることもない。**
 *
 * ⚠️ 上限は入力と同じものを使う。**画像の都合で入力を狭めない**（#146 の判断）。
 * 上限があること自体は要る（レイアウト崩れと CPU の両方を防ぐ）。
 */
export const exportImagePayloadSchema = z
  .object({
    title: z.string().min(1).max(LIST_TITLE_MAX_LENGTH),
    items: z
      .array(
        z
          .object({
            text: z.string().min(1).max(ITEM_TEXT_MAX_LENGTH),
            /** 「やった」印が付いているか。日時は画像に出さないので真偽値だけ */
            completed: z.boolean(),
          })
          .strict(),
      )
      .max(ITEMS_PER_LIST_MAX),
    /** 有効期限（epoch 秒）。**流出した署名をいつまでも使える状態にしない** */
    exp: z.number().int().positive(),
  })
  .strict()

export type ExportImagePayload = z.infer<typeof exportImagePayloadSchema>

/**
 * 署名の有効期間（秒）。
 *
 * OGP（1時間）より短い **5分**。
 * OGP は SNS が後から取りに来るので余裕が要るが、**こちらは押した直後に1回使うだけ。**
 * 短いほど、流出したときに困らない。
 */
export const EXPORT_IMAGE_SIGNATURE_TTL_SECONDS = 5 * 60

/**
 * 署名の対象を1つの文字列にする。**両側で同じ並びにするため、ここでしか作らない。**
 *
 * 🔴 **長さを前に付ける**（`5:南極に行く` の形）。
 * `og.ts` は改行で繋いでいるが、**入れ子があるとそれでは足りない。**
 * 区切り文字を項目テキストに書かれるだけで、別の内容が同じ文字列になってしまう
 * （例: 項目が1つで `a\nb` と、項目が2つで `a` `b`）。
 * **長さを前に付ければ、中身に何が入っていても取り違えない。**
 *
 * ⚠️ 数えるのは**コードポイント数ではなくバイト数**。
 * `String.length` はサロゲートペア（絵文字など）を2と数えるので、
 * 実装を移したときにずれる余地がある。バイト数なら曖昧さがない。
 */
function canonical(payload: ExportImagePayload): string {
  const encoder = new TextEncoder()
  const part = (value: string) => `${String(encoder.encode(value).length)}:${value}`

  return [
    part(payload.title),
    part(String(payload.exp)),
    part(String(payload.items.length)),
    ...payload.items.flatMap((item) => [part(item.text), part(item.completed ? '1' : '0')]),
  ].join('')
}

/** 署名を作る（Cloudflare Workers 側）。 */
export async function signExportImagePayload(
  payload: ExportImagePayload,
  secret: string,
): Promise<string> {
  return signCanonical(canonical(payload), secret)
}

/**
 * 期限が切れているか。
 *
 * `verifyExportImagePayload` の外に出してあるのは**ログのため**（#184 と同じ）。
 * 「期限切れ」と「署名が合わない」は原因も対処も違う。
 *
 * 🔴 **判定はここ1箇所。** 呼び出し側で `exp` を見比べ直さない。
 */
export function isExportImagePayloadExpired(payload: ExportImagePayload, now: Date): boolean {
  return payload.exp * 1000 <= now.getTime()
}

/**
 * 署名を確かめる（Deno Deploy 側）。
 *
 * **合わない理由を返さない。** 「期限切れ」も「改竄」も、
 * 呼び出し側にできることは変わらない（どちらも描かない）。
 *
 * `now` を引数で受け取るのはテストのため（`TECH_STACK.md` §10）。
 */
export async function verifyExportImagePayload(
  payload: ExportImagePayload,
  signature: string,
  secret: string,
  now: Date,
): Promise<boolean> {
  if (isExportImagePayloadExpired(payload, now)) return false

  return verifyCanonical(canonical(payload), signature, secret)
}
