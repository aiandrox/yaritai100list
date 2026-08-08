import { z } from 'zod'

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
 * ⚠️ **Deno でも動くものだけを使う**（`TECH_STACK.md` §12-2）。
 * HMAC は Node の `crypto` ではなく **Web Crypto**（`crypto.subtle`）で書く。
 * どちらのランタイムにもある。
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

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 署名を作る（Cloudflare Workers 側）。 */
export async function signOgPayload(payload: OgPayload, secret: string): Promise<string> {
  const key = await hmacKey(secret)
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonical(payload)),
  )

  return toHex(signature)
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

  const key = await hmacKey(secret)

  // 🔴 **自分で文字列比較しない。** `crypto.subtle.verify` は時間差で漏れない
  return crypto.subtle.verify(
    'HMAC',
    key,
    hexToBytes(signature),
    new TextEncoder().encode(canonical(payload)),
  )
}

/**
 * 16進の文字列をバイト列に戻す。**不正な文字が来たら空を返す**（検証は必ず落ちる）。
 *
 * 戻り値を `ArrayBuffer` にしているのは、`crypto.subtle.verify` が
 * `BufferSource` を要求するため（`Uint8Array<ArrayBufferLike>` は代入できない）。
 */
function hexToBytes(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return new ArrayBuffer(0)

  const buffer = new ArrayBuffer(hex.length / 2)
  const bytes = new Uint8Array(buffer)

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }

  return buffer
}
