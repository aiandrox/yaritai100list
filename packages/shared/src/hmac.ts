/**
 * HMAC の下回り（#189）。
 *
 * 🔴 **署名する側と確かめる側で同じものを使う。** 署名するのは Cloudflare Workers、
 * 確かめるのは Deno Deploy。**別々に書くと、片方を直したときにずれる**
 * （そしてずれたことに気づくのは「画像が出ない」という形でしかない）。
 *
 * ⚠️ **Deno でも動くものだけを使う**（`TECH_STACK.md` §12-2）。
 * Node の `crypto` ではなく **Web Crypto**（`crypto.subtle`）。どちらのランタイムにもある。
 *
 * ここには**署名の対象の作り方を置かない。** それは用途ごとに違う（`og.ts` / `export-image.ts`）。
 */

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

/** 文字列に署名する。戻り値は16進。 */
export async function signCanonical(canonical: string, secret: string): Promise<string> {
  const key = await hmacKey(secret)

  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)))
}

/**
 * 署名を確かめる。
 *
 * 🔴 **自分で文字列比較しない。** `crypto.subtle.verify` は時間差で漏れない。
 */
export async function verifyCanonical(
  canonical: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await hmacKey(secret)

  return crypto.subtle.verify(
    'HMAC',
    key,
    hexToBytes(signature),
    new TextEncoder().encode(canonical),
  )
}
