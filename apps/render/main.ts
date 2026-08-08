import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori from 'satori'

import {
  buildExportImageTemplate,
  buildOgTemplate,
  EXPORT_IMAGE_HEIGHT,
  EXPORT_IMAGE_MAX_BODY_BYTES,
  EXPORT_IMAGE_SIGNATURE_HEADER,
  EXPORT_IMAGE_WIDTH,
  exportImagePayloadSchema,
  isExportImagePayloadExpired,
  isOgPayloadExpired,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  ogPayloadSchema,
  verifyExportImagePayload,
  verifyOgPayload,
  type OgElement,
} from '../../packages/shared/src/index.ts'

/**
 * 画像生成サービス（Deno Deploy）。#172 / #191。
 *
 * **やることは1つだけ: 渡されたデータを描いて PNG で返す。**
 *
 * 経路は2つ。**中身も見た目も別だが、仕組みは全部共通**（`PRODUCT_SPEC.md` §5.3）。
 *
 * | | | |
 * |---|---|---|
 * | `GET /og` | SNS のカード | クエリに署名（小さいので URL に載る） |
 * | `POST /export` | やりたいこと全部 | 本文に署名（100項目は URL に載らない。#189） |
 *
 * 🔴 **公開/非公開をここで判断しない**（`CLAUDE.md` の不変条件）。
 * 認可は呼び出し側（Cloudflare Workers）で済んでいて、
 * その事実は**署名で担保されている。** ここは署名が合うかだけを見る。
 *
 * 🔴 **署名が無ければ描かない。** 誰でも叩ける状態にすると、
 * ラスタライズで CPU 枠を溶かす踏み台になる（`TECH_STACK.md` §9）。
 */

/**
 * 鍵。**無ければ起動時に落とす。**
 *
 * 「鍵が無いから素通し」が一番まずい。**動かない方がまし。**
 */
const SECRET = Deno.env.get('RENDER_HMAC_SECRET')
if (!SECRET) throw new Error('RENDER_HMAC_SECRET が設定されていない')

/**
 * ⚠️ **WASM とフォントはモジュールの読み込み時に1回だけ用意する**
 * （`TECH_STACK.md` §4.3）。リクエストごとに読むと CPU を無駄に使う。
 *
 * フォントは**フルセットを同梱**している（`fonts/`）。利用者が書いた任意の日本語を
 * 描くので、使う文字を事前に絞れない（§4.2）。
 */
// WASM も**リポジトリに置いてある**（`resvg.wasm`）。CDN から取ると、
// 起動のたびに外部に依存する（`TECH_STACK.md` §6 の「壊れる箇所を増やさない」）
await initWasm(await Deno.readFile(new URL('./resvg.wasm', import.meta.url)))

const FONTS = [
  {
    name: 'Noto Sans JP',
    data: (await Deno.readFile(new URL('./fonts/NotoSansJP-Regular.otf', import.meta.url))).buffer,
    weight: 400 as const,
    style: 'normal' as const,
  },
  {
    name: 'Noto Sans JP',
    data: (await Deno.readFile(new URL('./fonts/NotoSansJP-Bold.otf', import.meta.url))).buffer,
    weight: 700 as const,
    style: 'normal' as const,
  },
]

/**
 * 問い合わせから、描く内容を取り出す。
 *
 * 🔴 **合わない理由を応答に載せない。** 「期限切れ」も「改竄」も、
 * 呼び出し側にできることは変わらない（どちらも描かない）。
 * 出し分けると、叩く側に手がかりを与える。
 *
 * ⚠️ **ただしログには残す**（#184）。原因も対処も違うのに区別できず、
 * 実際に「両側の鍵が違う」のを見つけるのに時間がかかった。
 * **署名も鍵も書かない**（ログから叩けるようになる）。
 */
async function readPayload(url: URL, now: Date) {
  const params = url.searchParams

  const parsed = ogPayloadSchema.safeParse({
    title: params.get('title') ?? '',
    completed: Number(params.get('completed')),
    filled: Number(params.get('filled')),
    exp: Number(params.get('exp')),
  })

  if (!parsed.success) {
    // どの項目が形として通らなかったか。**値は書かない**
    console.error(
      `og: 形が違う（${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}）`,
    )
    return null
  }

  // 🔴 期限は `verifyOgPayload` も見る。ここで見るのは**ログのためだけ**。
  // 判定そのものは `isOgPayloadExpired` の1箇所にある
  if (isOgPayloadExpired(parsed.data, now)) {
    console.error('og: 期限が切れている（呼び出し側の時計がずれている可能性）')
    return null
  }

  const signature = params.get('sig') ?? ''
  if (!(await verifyOgPayload(parsed.data, signature, SECRET!, now))) {
    console.error('og: 署名が合わない（両側の RENDER_HMAC_SECRET が違う可能性）')
    return null
  }

  return parsed.data
}

/**
 * 描いて PNG にする。**2つの経路で共通**（`TECH_STACK.md` §4.3）。
 *
 * ⚠️ 戻り値を `Uint8Array<ArrayBuffer>` と書いているのは、
 * `Response` が `ArrayBufferLike` を受け取らないため（素の `Uint8Array` だと型が合わない）。
 */
async function toPng(
  element: OgElement,
  width: number,
  height: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const svg = await satori(element as never, { width, height, fonts: FONTS })

  return new Uint8Array(new Resvg(svg).render().asPng())
}

const forbidden = () => new Response('Forbidden', { status: 403 })

/**
 * 画像出力（#191）。**POST。本文に署名する。**
 *
 * OGP と違ってクエリに載せられない（100項目 × 22文字。#189）。
 * 署名は `x-signature` ヘッダで受け取る。
 */
async function handleExport(request: Request, now: Date): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  // 🔴 **読む前に切る。** 桁の大きい本文は、読むだけ無駄（`TECH_STACK.md` §9）
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > EXPORT_IMAGE_MAX_BODY_BYTES) {
    console.error('export: 本文が大きすぎる')
    return new Response('Payload Too Large', { status: 413 })
  }

  const body: unknown = await request.json().catch(() => null)
  const parsed = exportImagePayloadSchema.safeParse(body)

  if (!parsed.success) {
    // どの項目が形として通らなかったか。**値は書かない**
    console.error(
      `export: 形が違う（${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}）`,
    )
    return forbidden()
  }

  if (isExportImagePayloadExpired(parsed.data, now)) {
    console.error('export: 期限が切れている（呼び出し側の時計がずれている可能性）')
    return forbidden()
  }

  const signature = request.headers.get(EXPORT_IMAGE_SIGNATURE_HEADER) ?? ''
  if (!(await verifyExportImagePayload(parsed.data, signature, SECRET!, now))) {
    console.error('export: 署名が合わない（両側の RENDER_HMAC_SECRET が違う可能性）')
    return forbidden()
  }

  const png = await toPng(
    buildExportImageTemplate(parsed.data),
    EXPORT_IMAGE_WIDTH,
    EXPORT_IMAGE_HEIGHT,
  )

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // ⚠️ **キャッシュさせない。** URL にバージョンが無く（POST なので）、
      // 中身は押すたびに変わりうる。OGP とはここが違う
      'cache-control': 'no-store',
    },
  })
}

/** OGP 画像（#172）。**GET。クエリに署名。** */
async function handleOg(url: URL, now: Date): Promise<Response> {
  const payload = await readPayload(url, now)
  if (!payload) return forbidden()

  const png = await toPng(buildOgTemplate(payload), OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT)

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      // 呼び出し側（Cloudflare）でもキャッシュするが、ここでも効かせておく
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

/**
 * ⚠️ `async` を付けていないのは、**この関数自身は待たないから**
 * （`deno lint` の `require-await` に引っかかる）。
 * 戻り値に `Response` と `Promise<Response>` の両方があるのはそのため。
 */
export function handler(request: Request): Response | Promise<Response> {
  const url = new URL(request.url)
  const now = new Date()

  // 生きているかの確認用。**中身は返さない**
  if (url.pathname === '/health') return new Response('ok')

  if (url.pathname === '/og') return handleOg(url, now)
  if (url.pathname === '/export') return handleExport(request, now)

  return new Response('Not Found', { status: 404 })
}

// Deno Deploy はモジュールの既定の輸出を見る
export default { fetch: handler }
