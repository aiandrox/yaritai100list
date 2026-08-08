import { z } from 'zod'

import { signCanonical, verifyCanonical } from './hmac'
import { LIST_TITLE_MAX_LENGTH } from './limits'

/**
 * OGP 画像に渡すデータと、その署名（#170）。
 *
 * 🔴 **署名と検証を同じファイルに置く。** 署名するのは Cloudflare Workers、
 * 検証するのは Deno Deploy。**別々に書くと、片方を直したときにずれる**
 * （そしてずれたことに気づくのは「画像が出ない」という形でしかない）。
 *
 * 🔴 **生成サービスに公開/非公開を判断させない**（`CLAUDE.md` の不変条件）。
 * ここに来る時点で認可は済んでいる、という前提を**署名で担保する。**
 * 生成側は「署名が合っていれば描く」だけでよくなる。
 *
 * HMAC の下回りは `hmac.ts`。**署名の対象の作り方だけがここにある**
 * （用途ごとに違うため。画像出力は #189）。
 */

/**
 * 画像に描く内容。**タイトルと達成状況だけ**（`PRODUCT_SPEC.md` §5.2）。
 *
 * 🔴 **作者を入れない。** どの公開面にも作者を出さない（§5.1）。
 * **入れる場所が無ければ、間違えて入れることもない。**
 *
 * 項目の一覧も入れない。あれは画像出力（#9）の役割で、OGP には入らない。
 */
export const ogPayloadSchema = z
  .object({
    /** リストのタイトル。長さの上限は入力と同じ（レイアウト崩れと CPU の両方を防ぐ） */
    title: z.string().min(1).max(LIST_TITLE_MAX_LENGTH),
    /** 「やった」数 */
    completed: z.number().int().min(0),
    /** 書いた数。`completed / filled` で達成状況を出す */
    filled: z.number().int().min(0),
    /** 有効期限（epoch 秒）。**流出した URL をいつまでも叩ける状態にしない** */
    exp: z.number().int().positive(),
  })
  .strict()

export type OgPayload = z.infer<typeof ogPayloadSchema>

/**
 * 署名の有効期間（秒）。
 *
 * 短すぎると、SNS が後から取りに来たときに切れている。長すぎると流出したときに困る。
 * **1時間**にしてある。SNS のクローラは貼られた直後に来るので足りる。
 */
export const OG_SIGNATURE_TTL_SECONDS = 60 * 60

/** 署名の対象を1つの文字列にする。**両側で同じ並びにするため、ここでしか作らない。** */
function canonical(payload: OgPayload): string {
  // キーの順序で結果が変わらないよう、並びを固定して書く（JSON.stringify に任せない）
  return [payload.title, payload.completed, payload.filled, payload.exp]
    .map((value) => String(value))
    .join('\n')
}

/** 署名を作る（Cloudflare Workers 側）。 */
export async function signOgPayload(payload: OgPayload, secret: string): Promise<string> {
  return signCanonical(canonical(payload), secret)
}

/**
 * 期限が切れているか。
 *
 * ⚠️ **`verifyOgPayload` の外に出してあるのは、ログのため**（#184）。
 * 「期限切れ」と「署名が合わない」は原因も対処も違うのに、
 * どちらも 403 になって切り分けられなかった。
 *
 * 🔴 **判定はここ1箇所。** 呼び出し側で `exp` を見比べ直さない
 * （2箇所に書くと、片方だけ直る）。
 */
export function isOgPayloadExpired(payload: OgPayload, now: Date): boolean {
  return payload.exp * 1000 <= now.getTime()
}

/**
 * 署名を確かめる（Deno Deploy 側）。
 *
 * **合わない理由を返さない。** 「期限切れ」も「改竄」も、
 * 呼び出し側にできることは変わらない（どちらも描かない）。
 * 理由が要るのは**ログだけ**なので、`isOgPayloadExpired` を別に呼ぶ。
 *
 * `now` を引数で受け取るのはテストのため（`TECH_STACK.md` §10 と同じ理由で、
 * 関数の中で時計を読まない）。
 */
export async function verifyOgPayload(
  payload: OgPayload,
  signature: string,
  secret: string,
  now: Date,
): Promise<boolean> {
  if (isOgPayloadExpired(payload, now)) return false

  return verifyCanonical(canonical(payload), signature, secret)
}
