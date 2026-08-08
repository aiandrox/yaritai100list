import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori from 'satori'

import {
  buildExportImageTemplate,
  buildOgTemplate,
  EXPORT_IMAGE_HEIGHT,
  EXPORT_IMAGE_WIDTH,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  type OgElement,
} from '../../packages/shared/src/index.ts'

/**
 * テンプレートを目で確かめるための道具（#190）。**本番の経路では使わない。**
 *
 * ⚠️ **レイアウトはテストでは守れない。** 「何が載っているか」は
 * `export-image-template.test.ts` で固定できるが、
 * **溢れているか・詰まりすぎか・読めるかは画像を見るまで分からない**
 * （実際 #190 で、25行目が下の余白を突き抜けているのを見て気づいた）。
 *
 * ```
 * deno task preview
 * ```
 *
 * 出力は `preview-*.png`（git は追わない）。
 */

const here = (path: string) => new URL(path, import.meta.url)

await initWasm(await Deno.readFile(here('./resvg.wasm')))

const FONTS = [
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
]

async function write(name: string, element: OgElement, width: number, height: number) {
  const svg = await satori(element as never, { width, height, fonts: FONTS })

  await Deno.writeFile(here(`./${name}.png`), new Uint8Array(new Resvg(svg).render().asPng()))
  console.log(`${name}.png`)
}

/** 実際に書かれそうな文言。**長さがまちまちなものを混ぜる。** */
const SAMPLES = [
  '南極でオーロラを見る',
  'フルマラソンを完走する',
  '茶道を習う',
  '祖母の手料理を再現する',
  '一人で海外に行く',
  '朝5時に起きる生活',
  '古い写真を全部整理する',
  'ピアノで一曲弾く',
  '同僚に感謝を伝える',
  '本を100冊読む',
  '登山で富士山に登る',
  '陶芸で器を作る',
]

const filled = Array.from({ length: 62 }, (_, index) => ({
  text: SAMPLES[index % SAMPLES.length] ?? '',
  completed: index % 5 === 0,
}))

// 途中まで書いた、いちばん普通の状態
await write(
  'preview-export',
  buildExportImageTemplate({ title: '人生でやりたいことリスト', items: filled, exp: 1 }),
  EXPORT_IMAGE_WIDTH,
  EXPORT_IMAGE_HEIGHT,
)

// 🔴 いちばん詰まる状態。**上限まで書かれても崩れないこと**を見る
await write(
  'preview-export-full',
  buildExportImageTemplate({
    title: 'あ'.repeat(LIST_TITLE_MAX_LENGTH),
    items: Array.from({ length: ITEMS_PER_LIST_MAX }, (_, index) => ({
      text: 'あ'.repeat(ITEM_TEXT_MAX_LENGTH),
      completed: index % 3 === 0,
    })),
    exp: 1,
  }),
  EXPORT_IMAGE_WIDTH,
  EXPORT_IMAGE_HEIGHT,
)

// 1件も書いていない状態。**空欄の番号だけが並ぶ**
await write(
  'preview-export-empty',
  buildExportImageTemplate({ title: '人生でやりたいことリスト', items: [], exp: 1 }),
  EXPORT_IMAGE_WIDTH,
  EXPORT_IMAGE_HEIGHT,
)

await write(
  'preview-og',
  buildOgTemplate({ title: '人生でやりたいことリスト', completed: 12, filled: 62, exp: 1 }),
  OG_IMAGE_WIDTH,
  OG_IMAGE_HEIGHT,
)
