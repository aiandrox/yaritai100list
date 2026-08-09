import type { ExportImagePayload } from './export-image'
import { ITEMS_PER_LIST_MAX } from './limits'
import { OG_IMAGE_WIDTH, type OgElement } from './og-template'
import { SERVICE_NAME, SERVICE_TAGLINE } from './service'

/**
 * 画像出力のレイアウト（#190）。**4列 × 25行に 001〜100 を全部並べる。**
 *
 * OGP（`og-template.ts`）とは**中身も見た目も別**（`PRODUCT_SPEC.md` §5.3）。
 * OGP は「タイトルと達成状況」、こちらは「やりたいこと全部」を見せる。
 * 共有しているのは**ラスタライズの仕組みだけ**（実行場所・レンダラ・フォント・署名の作法）。
 *
 * 🔴 **grid は使えない**（Satori が対応していない。`TECH_STACK.md` §4.3）。
 * 4つの列を横に並べ、各列の中で25行を縦に積む。**これは flexbox だけで組める。**
 *
 * 🔴 **背景の繰り返しパターンを使わない**（`background-repeat` の対応が怪しい）。
 *
 * 参考にしたのは nolty「1年でやりたい100のコト」の**レイアウトの構造だけ。**
 * 配色は自前（`tokens.css` と同じ）。
 */

/**
 * 画像の大きさ。**約 1.41:1**（A4 横に近い。`PRODUCT_SPEC.md` §5.3）。
 *
 * OGP（1200×630 の 1.91:1）とは違う。**縦横比を揃える理由が無い**
 * （あちらは SNS のカード枠、こちらは保存して見るもの）。
 */
export const EXPORT_IMAGE_WIDTH = 2000
export const EXPORT_IMAGE_HEIGHT = 1414

/**
 * 色。**`tokens.css` と同じ値**（#159）。
 *
 * ⚠️ `og-template.ts` にも同じものがある。**4箇所目の定義。**
 * Satori に渡すのは JS のオブジェクトなので CSS を読めない、というのが理由
 * （`og-template.ts` の同じコメントを参照）。
 */
const COLORS = {
  brandSoft: '#fff5f6',
  brandDeep: '#b34452',
  ink: '#0f172a',
  muted: '#94a3b8',
  line: '#f3d7db',
} as const

/**
 * 文字の見た目の幅を数える。**単位は半角1文字ぶん。**
 *
 * 🔴 **文字数で数えない。** 全角と半角で見た目の幅が倍違うので、
 * 「30文字」だけでは収まるかどうか判断できない（#9 のコメントの決定）。
 *
 * ⚠️ **これは見積もり。** Satori に測らせられないので、
 * 全角を2・半角を1として数える。プロポーショナルな欧文までは合わないが、
 * **収まるかどうかの判断には足りる**（外すとしても安全側に外れる）。
 */
export function displayWidth(value: string): number {
  let width = 0

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0

    // ASCII と半角カナは1、それ以外（漢字・かな・全角記号・絵文字）は2
    width += code <= 0x7f || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2
  }

  return width
}

const PADDING = 72
const COLUMNS = 4
const ROWS = ITEMS_PER_LIST_MAX / COLUMNS
const COLUMN_GAP = 24

/**
 * 行と行の隙間。
 *
 * ⚠️ **25行が下の余白の中に収まる値。** 広げると 100 行目が画像の端まで伸びる
 * （Satori は溢れても切ってくれない。**目で見るまで気づけない**）。
 */
const ROW_GAP = 9

/** 中身を置ける幅。左右の余白を引いたもの。 */
const CONTENT_WIDTH = EXPORT_IMAGE_WIDTH - PADDING * 2

/** 1列の幅。列と列の間の隙間を差し引いて4等分する。 */
const COLUMN_WIDTH = (CONTENT_WIDTH - COLUMN_GAP * (COLUMNS - 1)) / COLUMNS

/** 右上のサービス名の大きさ。 */
const SERVICE_FONT_SIZE = 26

/**
 * 見出しに使える幅。**サービス名の分を空けてある。**
 *
 * 🔴 **空ける幅を手で書かない。** サービス名の実際の幅から引く。
 * 決め打ちにすると、名前が変わったときに**見出しと重なる**（気づくのは画像を見たときだけ）。
 */
const TITLE_MAX_WIDTH = CONTENT_WIDTH - (displayWidth(SERVICE_NAME) * SERVICE_FONT_SIZE) / 2 - 48

/**
 * 見出しの大きさの候補。**大きい方から試す。**
 *
 * 一番小さい 48 は「読めなくなる下限」として決めた値。
 * 全角30文字（入力の上限。#146）は `30 × 48 = 1440` で収まる。
 */
const TITLE_FONT_SIZE_MIN = 48
const TITLE_FONT_SIZES = [88, 72, 60, TITLE_FONT_SIZE_MIN] as const

/**
 * 見出しを枠に収める。**まず小さくして、それでも溢れたら「…」で切る。**
 *
 * 🔴 **入力できる長さを画像の都合で決めない**（#9 のコメントの決定）。
 * 画像は「持ち出した結果」であって、書くときの制約にする理由がない。
 * だから**画像側で収める。**
 *
 * `maxWidth` を引数で受け取るのはテストのため（`TECH_STACK.md` §10）。
 */
export function fitTitle(
  title: string,
  maxWidth: number = TITLE_MAX_WIDTH,
): { text: string; fontSize: number } {
  // 半角1文字ぶんの幅は、おおよそ「文字の大きさの半分」
  const widthAt = (fontSize: number, value: string) => (displayWidth(value) * fontSize) / 2

  const fontSize = TITLE_FONT_SIZES.find((size) => widthAt(size, title) <= maxWidth)
  if (fontSize !== undefined) return { text: title, fontSize }

  // 一番小さくしても溢れる。**末尾を切る。**
  // 切る位置は**文字数ではなく見た目の幅**で決める（全角と半角で変わるため）
  const smallest = TITLE_FONT_SIZE_MIN
  const budget = maxWidth - widthAt(smallest, '…')

  let text = ''
  for (const character of title) {
    if (widthAt(smallest, text + character) > budget) break
    text += character
  }

  return { text: `${text}…`, fontSize: smallest }
}

function element(
  style: Record<string, string | number>,
  children?: OgElement | OgElement[] | string,
): OgElement {
  return {
    type: 'div',
    props: {
      // 🔴 **`display: flex` を明示する。** Satori は既定が flex でなく、
      // 書かないと落ちることがある（`TECH_STACK.md` §4.3）
      style: { display: 'flex', ...style },
      // `exactOptionalPropertyTypes` が効いているので、無いときは**鍵ごと置かない**
      ...(children === undefined ? {} : { children }),
    },
  }
}

/**
 * 行の寸法。**書き出し画像とトップページの OGP で使い回す**（#229）。
 *
 * 大きさは違うが、**行の作り（番号 → 本文、下に細い罫）は同じ。**
 * 別々に書くと、片方だけ直したときに見た目がずれる。
 */
interface RowSize {
  columnWidth: number
  numberWidth: number
  numberFontSize: number
  textFontSize: number
}

const EXPORT_ROW: RowSize = {
  columnWidth: COLUMN_WIDTH,
  numberWidth: 46,
  numberFontSize: 20,
  textFontSize: 17,
}

/**
 * 1行ぶん。**番号と、その右の項目テキスト。**
 *
 * 未入力でも**番号だけは出す**（`PRODUCT_SPEC.md` §5.3）。
 * 100個すべて並べることで「まだ埋まっていない」が見える。
 * アプリ画面で100行を必ず描くのと同じ思想（§4.5）。
 */
function row(
  index: number,
  item: { text: string; completed: boolean } | undefined,
  size: RowSize = EXPORT_ROW,
): OgElement {
  const number = String(index + 1).padStart(3, '0')

  return element(
    {
      width: `${String(size.columnWidth)}px`,
      alignItems: 'center',
      gap: '10px',
      paddingBottom: '4px',
      borderBottom: `1px solid ${COLORS.line}`,
    },
    [
      element(
        {
          width: `${String(size.numberWidth)}px`,
          justifyContent: 'flex-end',
          fontSize: size.numberFontSize,
          fontWeight: 700,
          // 🔴 **番号は全部同じ色**（2026-08-08 の利用者の判断）。
          // 「やった」かどうかは**項目テキスト側**（取り消し線と文字色）で見せる。
          // 番号でも出し分けると、001〜100 の並びが読みにくくなる
          color: COLORS.brandDeep,
        },
        number,
      ),
      element(
        {
          flexGrow: 1,
          fontSize: size.textFontSize,
          color: item?.completed === true ? COLORS.muted : COLORS.ink,
          // 22文字（入力の上限）でも収まる大きさにしてあるが、**念のため切る**
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...(item?.completed === true ? { textDecoration: 'line-through' } : {}),
        },
        item?.text ?? '',
      ),
    ],
  )
}

/**
 * 画像を組み立てる。**純関数**（`TECH_STACK.md` §10）。
 *
 * 載せるのは**タイトルとやりたいこと全部**。
 * 🔴 **作者は載せない**（そもそも `ExportImagePayload` に入っていない）。
 */
export function buildExportImageTemplate(payload: ExportImagePayload): OgElement {
  const title = fitTitle(payload.title)

  // 縦に25行ずつ積んだ列を4つ。**左上から下へ、次の列の上へ**と読ませる
  const columns = Array.from({ length: COLUMNS }, (_, column) =>
    element(
      { flexDirection: 'column', gap: `${String(ROW_GAP)}px` },
      Array.from({ length: ROWS }, (_, line) => {
        const index = column * ROWS + line

        return row(index, payload.items[index])
      }),
    ),
  )

  return element(
    {
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      padding: `${String(PADDING)}px`,
      backgroundColor: COLORS.brandSoft,
      // フォント名は Deno 側が読み込むときの名前と合わせる
      fontFamily: 'Noto Sans JP',
      color: COLORS.ink,
    },
    [
      element({ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '40px' }, [
        element({ fontSize: title.fontSize, fontWeight: 700 }, title.text),
        element(
          { fontSize: SERVICE_FONT_SIZE, fontWeight: 700, color: COLORS.brandDeep },
          SERVICE_NAME,
        ),
      ]),

      element({ flexGrow: 1, gap: `${String(COLUMN_GAP)}px` }, columns),
    ],
  )
}

// ---------------------------------------------------------------------------
// トップページの OGP（#229）
// ---------------------------------------------------------------------------

/**
 * トップページの OGP 画像。**書き出し画像のデザインを踏襲する**
 * （2026-08-09 の利用者の判断）。
 *
 * 🔴 **サービス名と一言だけのカードにしない。** それだと
 * 「何かのアプリらしい」までしか伝わらない。
 * **番号付きの升目と取り消し線**を見せれば、
 * 「たくさん書いて、叶えたら印を付けるもの」が文を読まなくても分かる。
 *
 * 🔴 **これだけは動的に作らない。** 中身が変わらないので、**1枚だけ作って
 * `apps/web/public/og.png` に置く**（生成は `apps/render` の `deno task og`）。
 * リストの OGP は毎回 Deno Deploy を叩くが、**トップページは入口なので、
 * 画像生成サービスが落ちていても壊れてはいけない**（実際に 503 になった。#180 / #184）。
 *
 * ⚠️ **文言や配色を変えたら `deno task og` を流し直して PNG をコミットし直すこと。**
 * ここを直しても画像は自動では追従しない。
 */
export function buildServiceOgTemplate(): OgElement {
  const columns = Array.from({ length: SERVICE_OG_COLUMNS }, (_, column) =>
    element(
      { flexDirection: 'column', gap: `${String(SERVICE_OG_ROW_GAP)}px` },
      Array.from({ length: SERVICE_OG_ROWS }, (_, line) => {
        const index = column * SERVICE_OG_ROWS + line

        return row(index, SERVICE_OG_SAMPLE[index], SERVICE_OG_ROW)
      }),
    ),
  )

  return element(
    {
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      padding: `${String(SERVICE_OG_PADDING)}px`,
      backgroundColor: COLORS.brandSoft,
      fontFamily: 'Noto Sans JP',
      color: COLORS.ink,
    },
    [
      /**
       * 見出しと一言。**縦に積む**（2026-08-09 の利用者の判断）。
       *
       * 🔴 **横に並べない。** 右端に小さく置くと、見出しの飾りに見えて読まれない。
       * **下に置けば見出しの続きとして読まれる。**
       *
       * 🔴 **薄い色にしない。** ここは「何のサービスか」を言う唯一の文なので、
       * 本文と同じ濃さ（`COLORS.ink`）にする。
       * 薄いのは升目の「やった分」だけでよい。
       */
      element({ flexDirection: 'column', gap: '10px', marginBottom: '24px' }, [
        element({ fontSize: SERVICE_OG_NAME_FONT_SIZE, fontWeight: 700 }, SERVICE_NAME),
        element({ fontSize: SERVICE_OG_TAGLINE_FONT_SIZE, color: COLORS.ink }, SERVICE_TAGLINE),
      ]),

      element({ flexGrow: 1, gap: `${String(SERVICE_OG_COLUMN_GAP)}px` }, columns),
    ],
  )
}

const SERVICE_OG_NAME_FONT_SIZE = 54
const SERVICE_OG_TAGLINE_FONT_SIZE = 26

/**
 * 見出しと一言のうち、**長い方**が使う幅。
 *
 * 縦に積んであるので**足し算ではなく、どちらか広い方**を見る。
 *
 * ⚠️ **`SERVICE_OG_CONTENT_WIDTH` を超えると折り返す**（Satori は縮めない）。
 * 折り返すと升目が下へ押し出され、**一番下の行が画像からはみ出す。**
 * **文言を変えたときにここが破れる**ので、テストで固定してある。
 */
export const SERVICE_OG_HEADER_WIDTH = Math.max(
  (displayWidth(SERVICE_NAME) * SERVICE_OG_NAME_FONT_SIZE) / 2,
  (displayWidth(SERVICE_TAGLINE) * SERVICE_OG_TAGLINE_FONT_SIZE) / 2,
)

/**
 * OGP に並べる見本の数。
 *
 * 🔴 **書き出し画像の 100 とは違う。** あちらは 4列 × 25行に全部並べるが、
 * OGP は横長（1.91:1）で縦が足りない。**入るところまでにする**
 * （2026-08-09 の利用者の判断）。
 *
 * ⚠️ **増やすと一番下の行が画像からはみ出す。** Satori は溢れても切らないので、
 * 変えたら `deno task og` を流して**目で見ること。**
 */
export const SERVICE_OG_ITEM_COUNT = 40

const SERVICE_OG_PADDING = 48
const SERVICE_OG_COLUMNS = 4
const SERVICE_OG_ROWS = 10
const SERVICE_OG_COLUMN_GAP = 20
const SERVICE_OG_ROW_GAP = 8

/** 中身を置ける幅。**書き出し画像と同じ数え方。** */
export const SERVICE_OG_CONTENT_WIDTH = OG_IMAGE_WIDTH - SERVICE_OG_PADDING * 2

const SERVICE_OG_COLUMN_WIDTH =
  (SERVICE_OG_CONTENT_WIDTH - SERVICE_OG_COLUMN_GAP * (SERVICE_OG_COLUMNS - 1)) / SERVICE_OG_COLUMNS

const SERVICE_OG_ROW: RowSize = {
  columnWidth: SERVICE_OG_COLUMN_WIDTH,
  numberWidth: 38,
  numberFontSize: 17,
  textFontSize: 16,
}

/**
 * 見本の項目に使える幅（半角何文字ぶんか）。
 *
 * 🔴 **決め打ちの数字にしない。** 列の幅から番号と隙間を引いて出す。
 * 直に「13文字まで」と書くと、列の数を変えたときに**黙って溢れる**
 * （Satori は溢れても切らない。気づくのは画像を見たときだけ）。
 */
export const SERVICE_OG_TEXT_WIDTH =
  ((SERVICE_OG_COLUMN_WIDTH - SERVICE_OG_ROW.numberWidth - 10) / SERVICE_OG_ROW.textFontSize) * 2

/**
 * OGP に載せる見本のやりたいこと。
 *
 * 🔴 **実在の誰かのリストではない。** ここに書いたものが全世界のカードに出る。
 * **書きそうで、当たり障りのないもの**を選ぶ。
 *
 * ⚠️ **`SERVICE_OG_TEXT_WIDTH` に収まる長さにすること**（テストで固定してある）。
 * 溢れても Satori は切らないので、テストが無いと気づけない。
 *
 * 「やった」印は7個おき。**多すぎると取り消し線だらけで読みにくく、
 * 少なすぎると「印を付ける」が伝わらない。**
 *
 * ⚠️ **行数の約数にしない。** 10行なので5個おきにすると
 * **どの列も1行目と6行目が消える**という規則的な縞になり、作り物に見える。
 * 7 は 10 と互いに素なので、列ごとに位置がずれる。
 */
const SERVICE_OG_SAMPLE = [
  '富士山に登る',
  'オーロラを見る',
  'フルマラソンを走る',
  '茶道を習う',
  '一人で海外へ行く',
  'ピアノで一曲弾く',
  '本を100冊読む',
  '陶芸で器を作る',
  '祖母の味を再現する',
  '星空の下で眠る',
  '気球に乗る',
  '京都で紅葉を見る',
  '短編小説を書く',
  '犬と暮らす',
  '家庭菜園を始める',
  '献血に行く',
  '落語を寄席で聴く',
  '温泉宿に泊まる',
  '手紙を書いて出す',
  '早起きを習慣にする',
  '古い写真を整理する',
  '自分でパンを焼く',
  '山小屋で朝日を見る',
  'スペイン語を習う',
  '海外の友人に会う',
  '三味線を触ってみる',
  '夜行列車に乗る',
  '美術館を巡る',
  '自転車で海まで行く',
  '蕎麦を打つ',
  '座禅を組む',
  '親に旅行を贈る',
  '島に一週間滞在する',
  '銭湯を巡る',
  '苔の鉢を育てる',
  '流氷を見に行く',
  '写真展を開く',
  '廃線跡を歩く',
  '大きな図書館へ行く',
  '燻製を作る',
].map((text, index) => ({ text, completed: index % 7 === 0 }))
