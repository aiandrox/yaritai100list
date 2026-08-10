import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori from 'satori'

import {
  buildExportImageTemplate,
  EXPORT_IMAGE_HEIGHT,
  EXPORT_IMAGE_WIDTH,
} from '../../packages/shared/src/index.ts'

/**
 * 書き出す画面に出す**見本**の画像を1枚作る（#240）。
 *
 * ```
 * deno task sample
 * ```
 *
 * 🔴 **出力は `apps/web/public/export-sample.png`。git で追う**
 * （`preview.ts` の出力とは違う。あちらはレイアウトを目で見るための使い捨て）。
 *
 * 画像はサーバーで作るので、押してから返るまで数秒かかる。
 * **押す前に「何が出てくるか」が分からないのは、この形式だけだった**
 * （JSON とマークダウンは中身を画面で確かめられる）。
 *
 * 🔴 **実際のプレビューにしない。** 本人のリストで作ると、
 * **画面を開いただけで生成サービスを叩く**ことになり、数秒とレート制限の枠
 * （60秒で10回。#192）を消費する。見本が1枚あれば伝わる。
 *
 * ⚠️ **テンプレート（`export-image-template.ts`）を変えたら、これを流し直して
 * PNG をコミットし直すこと。** 見本と実物がずれると、かえって不信を招く。
 *
 * 縮小して出す。実物は 2000x1414 で、**画面に出るのは幅 350px ほど。**
 * そのまま置くと、見本1枚のために 100KB 以上を毎回読ませることになる。
 */

/** 画面に出る幅の約2倍。細かい文字は読めなくてよく、**詰まり具合が伝わればよい** */
const SAMPLE_WIDTH = 800

const here = (path: string) => new URL(path, import.meta.url)

/**
 * 見本の中身。
 *
 * 🔴 **実在の利用者が書いたものを使わない**（`/discover` から持ってこない）。
 * 公開されているものでも、**見本として焼き込むのは別の話。**
 *
 * 🔴 **同じ文言を繰り返さない。** 一番知りたいのは「100個並べたときの詰まり具合」で、
 * 同じ行が並ぶと**その判断ができない**（`preview.ts` は数個を使い回しているが、
 * あちらは崩れを探す道具なので目的が違う）。
 *
 * 長さはまちまちにする。**短い文だけだと、長い項目が入ったときの見え方が分からない。**
 * 全部は埋めない。**空欄の番号が並ぶ様子も、実物の一部**。
 */
const SAMPLE_ITEMS = [
  '南極でオーロラを見る',
  'フルマラソンを完走する',
  '茶道を習う',
  '祖母の手料理を再現する',
  '一人で海外に行く',
  '朝5時に起きる生活を1か月続ける',
  '古い写真を全部整理する',
  'ピアノで一曲弾けるようになる',
  '同僚に感謝を伝える',
  '本を100冊読む',
  '富士山に登る',
  '陶芸で自分の器を作る',
  '実家の畑を手伝う',
  '献血に行く',
  '知らない駅で降りて散歩する',
  '手紙を書いて出す',
  '真夜中に星を見に行く',
  '自転車で100km走る',
  '味噌を仕込む',
  '英語で映画を字幕なしで観る',
  '長い階段のある神社に行く',
  '家族と温泉に泊まる',
  '包丁を研げるようになる',
  'ぬか床を育てる',
  '古本屋を1日かけて巡る',
  '滝を見に行く',
  '路面電車に端から端まで乗る',
  '自分で焙煎した豆で淹れる',
  '朝市で魚を買って捌く',
  '写ルンですで一本撮り切る',
  'figma でロゴを作る',
  '好きな作家の全作品を読む',
  '夜行バスで遠くまで行く',
  '苔玉を育てる',
  '祖父の話を録音しておく',
  '一日中なにもしない日を作る',
  '短歌を三十首つくる',
  'ラジオに投稿して読まれる',
  '灯台のある岬まで歩く',
  '寝台列車に乗る',
  '手ぶらで散歩に出る',
  '古い映画を映画館で観る',
  '包丁一本で魚をおろす',
  'キャンプで焚き火をする',
  '真っ白なスニーカーを履き潰す',
  '通し狂言を最後まで観る',
  '知らない街の銭湯に入る',
  '畑で採れた野菜だけで一食作る',
  '雪の日に温泉に入る',
  '海の見える宿に泊まる',
  '毛筆で年賀状を書く',
  '一年分の日記を読み返す',
  '始発で海を見に行く',
  '大きな図書館で一日過ごす',
  '知人の結婚式で挨拶をする',
  '山小屋に泊まって朝日を見る',
  '古地図を持って街を歩く',
  '一度も乗ったことのない路線に乗る',
  '土鍋でご飯を炊く',
  '好きな喫茶店の常連になる',
  '祖母とふたりで旅行に行く',
  '自分の部屋の物を半分にする',
]

await initWasm(await Deno.readFile(here('./resvg.wasm')))

const svg = await satori(
  buildExportImageTemplate({
    title: '人生でやりたいことリスト',
    // 5個に1個くらいは叶っている、という普通の状態
    items: SAMPLE_ITEMS.map((text, index) => ({ text, completed: index % 5 === 0 })),
    exp: 1,
  }) as never,
  {
    width: EXPORT_IMAGE_WIDTH,
    height: EXPORT_IMAGE_HEIGHT,
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
  },
)

const png = new Resvg(svg, { fitTo: { mode: 'width', value: SAMPLE_WIDTH } }).render().asPng()

await Deno.writeFile(here('../web/public/export-sample.png'), new Uint8Array(png))
console.log(`apps/web/public/export-sample.png (${String(SAMPLE_WIDTH)}px 幅に縮小)`)
