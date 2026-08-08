import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori from 'satori'

import {
  buildOgTemplate,
  isOgPayloadExpired,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  ogPayloadSchema,
  verifyOgPayload,
} from '../../packages/shared/src/index.ts'

/**
 * 画像生成サービス（Deno Deploy）。#172。
 *
 * **やることは1つだけ: 渡されたデータを描いて PNG で返す。**
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

export async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // 生きているかの確認用。**中身は返さない**
  if (url.pathname === '/health') return new Response('ok')

  if (url.pathname !== '/og') return new Response('Not Found', { status: 404 })

  const payload = await readPayload(url, new Date())
  if (!payload) return new Response('Forbidden', { status: 403 })

  const svg = await satori(buildOgTemplate(payload) as never, {
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    fonts: FONTS,
  })

  const png = new Resvg(svg).render().asPng()

  return new Response(new Uint8Array(png), {
    headers: {
      'content-type': 'image/png',
      // 呼び出し側（Cloudflare）でもキャッシュするが、ここでも効かせておく
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

// Deno Deploy はモジュールの既定の輸出を見る
export default { fetch: handler }
