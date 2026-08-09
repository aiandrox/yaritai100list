import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori from 'satori'

import {
  buildServiceOgTemplate,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
} from '../../packages/shared/src/index.ts'

/**
 * トップページの OGP 画像を1枚だけ作る（#229）。
 *
 * ```
 * deno task og
 * ```
 *
 * 🔴 **出力は `apps/web/public/og.png`。git で追う**（`preview.ts` の出力とは違う）。
 *
 * 中身が変わらない画像なので、**リクエストのたびに作らない。**
 * トップページはサービスの入口で、**画像生成サービスが落ちていても壊れてはいけない**
 * （実際に Deno Deploy の無料枠切れで 503 になったことがある。#180 / #184）。
 * 静的ファイルとして置いておけば、そもそも依存しない。
 *
 * ⚠️ **文言を変えたら、これを流し直して PNG をコミットし直すこと。**
 * `SERVICE_NAME` / `SERVICE_TAGLINE` を変えても画像は自動では追従しない。
 */

const here = (path: string) => new URL(path, import.meta.url)

await initWasm(await Deno.readFile(here('./resvg.wasm')))

const svg = await satori(buildServiceOgTemplate() as never, {
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  fonts: [
    {
      name: 'Noto Sans JP',
      data: (await Deno.readFile(here('./fonts/NotoSansJP-Regular.otf'))).buffer,
      weight: 400 as const,
      style: 'normal' as const,
    },
    {
      name: 'Noto Sans JP',
      data: (await Deno.readFile(here('./fonts/NotoSansJP-Bold.otf'))).buffer,
      weight: 700 as const,
      style: 'normal' as const,
    },
  ],
})

await Deno.writeFile(here('../web/public/og.png'), new Uint8Array(new Resvg(svg).render().asPng()))
console.log(`apps/web/public/og.png (${String(OG_IMAGE_WIDTH)}x${String(OG_IMAGE_HEIGHT)})`)

/**
 * ホーム画面に置いたときのアイコン（`apple-touch-icon`）。
 *
 * **ファビコンの SVG から起こす。** 別に描くと必ずずれる。
 * iOS は SVG のアイコンを読まないので、**PNG が要るのはここだけ。**
 * Satori は通さない（あれは HTML 風のオブジェクトを SVG にする道具で、
 * すでに SVG があるならそのまま resvg に渡せばよい）。
 */
const APPLE_TOUCH_ICON_SIZE = 180

const favicon = await Deno.readTextFile(here('../web/public/favicon.svg'))
const icon = new Resvg(favicon, {
  fitTo: { mode: 'width', value: APPLE_TOUCH_ICON_SIZE },
})

await Deno.writeFile(
  here('../web/public/apple-touch-icon.png'),
  new Uint8Array(icon.render().asPng()),
)
console.log(
  `apps/web/public/apple-touch-icon.png (${String(APPLE_TOUCH_ICON_SIZE)}x${String(APPLE_TOUCH_ICON_SIZE)})`,
)
