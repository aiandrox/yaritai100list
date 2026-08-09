import {
  buildExportImageTemplate,
  buildServiceOgTemplate,
  displayWidth,
  EXPORT_IMAGE_HEIGHT,
  EXPORT_IMAGE_WIDTH,
  fitTitle,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
  SERVICE_NAME,
  SERVICE_OG_TEXT_WIDTH,
  SERVICE_TAGLINE,
  type ExportImagePayload,
  type OgElement,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

/**
 * 画像出力のレイアウトのテスト（#190）。
 *
 * Satori に渡すのは**ただのオブジェクト**なので、Deno を持ち出さずにここで固定できる。
 * 見た目そのものは目で見るしかないが、**「何が載っているか」は型と構造で守れる。**
 */

function payload(overrides: Partial<ExportImagePayload> = {}): ExportImagePayload {
  return {
    title: '人生でやりたいことリスト',
    items: [
      { text: '南極に行く', completed: true },
      { text: 'オーロラを見る', completed: false },
    ],
    exp: 1,
    ...overrides,
  }
}

function items(count: number, completed = false) {
  return Array.from({ length: count }, (_, index) => ({
    text: `やりたいこと${String(index + 1)}`,
    completed,
  }))
}

/** 木の中の文字列を全部集める。 */
function texts(element: OgElement | OgElement[] | string): string[] {
  if (typeof element === 'string') return [element]
  if (Array.isArray(element)) return element.flatMap(texts)

  const children = element.props.children

  return children === undefined ? [] : texts(children)
}

/** 木の中のスタイルを全部集める。 */
function styles(element: OgElement | OgElement[] | string): Record<string, unknown>[] {
  if (typeof element === 'string') return []
  if (Array.isArray(element)) return element.flatMap(styles)

  const children = element.props.children
  const own = element.props.style === undefined ? [] : [element.props.style]

  return children === undefined ? own : [...own, ...styles(children)]
}

describe('displayWidth', () => {
  it('全角は2、半角は1で数える', () => {
    expect(displayWidth('あい')).toBe(4)
    expect(displayWidth('abcd')).toBe(4)
    expect(displayWidth('あa')).toBe(3)
  })

  it('🔴 文字数では数えない（同じ文字数でも幅が違う）', () => {
    expect(displayWidth('ああああ')).not.toBe(displayWidth('aaaa'))
  })

  it('絵文字でも落ちない', () => {
    // サロゲートペアを2文字と数えないよう、コードポイントで回している
    expect(displayWidth('🎉')).toBe(2)
  })
})

describe('fitTitle', () => {
  it('短ければ一番大きいまま', () => {
    const fitted = fitTitle('目標', 1500)

    expect(fitted.text).toBe('目標')
    expect(fitted.fontSize).toBe(88)
  })

  it('🔴 長ければまず小さくする（切る前に）', () => {
    const long = 'あ'.repeat(LIST_TITLE_MAX_LENGTH)
    const fitted = fitTitle(long, 1500)

    // 切られていない。**入力できる長さを画像の都合で決めない**（#9）
    expect(fitted.text).toBe(long)
    expect(fitted.fontSize).toBeLessThan(88)
  })

  it('🔴 入力の上限（30文字）は切られずに収まる', () => {
    const fitted = fitTitle('あ'.repeat(LIST_TITLE_MAX_LENGTH))

    expect(fitted.text).not.toContain('…')
  })

  it('小さくしても溢れるなら「…」で切る', () => {
    const fitted = fitTitle('あ'.repeat(100), 400)

    expect(fitted.text.endsWith('…')).toBe(true)
    expect(fitted.text.length).toBeLessThan(100)
  })

  it('🔴 切った後も枠に収まっている', () => {
    const maxWidth = 400
    const fitted = fitTitle('あ'.repeat(100), maxWidth)

    expect((displayWidth(fitted.text) * fitted.fontSize) / 2).toBeLessThanOrEqual(maxWidth)
  })

  it('🔴 切る位置は文字数ではなく幅で決める', () => {
    // 同じ文字数でも、半角の方が多く残る
    const fullWidth = fitTitle('あ'.repeat(100), 400)
    const halfWidth = fitTitle('a'.repeat(100), 400)

    expect(halfWidth.text.length).toBeGreaterThan(fullWidth.text.length)
  })

  it('読めなくなる下限より小さくしない', () => {
    expect(fitTitle('あ'.repeat(100), 10).fontSize).toBe(48)
  })
})

describe('buildExportImageTemplate', () => {
  it('見出しとサービス名と項目が載る', () => {
    const found = texts(buildExportImageTemplate(payload()))

    expect(found).toContain('人生でやりたいことリスト')
    expect(found).toContain(SERVICE_NAME)
    expect(found).toContain('南極に行く')
  })

  it('🔴 番号が 001 から 100 まで全部ある（未入力でも出す）', () => {
    const found = texts(buildExportImageTemplate(payload({ items: [] })))

    expect(found).toContain('001')
    expect(found).toContain('100')
    expect(found.filter((value) => /^\d{3}$/.test(value))).toHaveLength(ITEMS_PER_LIST_MAX)
  })

  it('🔴 grid を使っていない（Satori が対応していない）', () => {
    const found = styles(buildExportImageTemplate(payload({ items: items(ITEMS_PER_LIST_MAX) })))

    for (const style of found) {
      expect(style.display).toBe('flex')
      expect(style.gridTemplateColumns).toBeUndefined()
    }
  })

  it('🔴 背景の繰り返しパターンを使っていない', () => {
    const found = styles(buildExportImageTemplate(payload()))

    for (const style of found) {
      expect(style.backgroundImage).toBeUndefined()
      expect(style.backgroundRepeat).toBeUndefined()
    }
  })

  it('🔴 100件すべて埋まっていても崩れない（4列 × 25行に収まる）', () => {
    const built = buildExportImageTemplate(payload({ items: items(ITEMS_PER_LIST_MAX) }))
    const found = texts(built)

    expect(found).toContain('やりたいこと1')
    expect(found).toContain('やりたいこと100')
    // 番号は 100 個のまま。**項目が増えても行は増えない**
    expect(found.filter((value) => /^\d{3}$/.test(value))).toHaveLength(ITEMS_PER_LIST_MAX)
  })

  it('🔴 1件も無くても崩れない', () => {
    expect(() => buildExportImageTemplate(payload({ items: [] }))).not.toThrow()
  })

  it('「やった」印を表現に含める', () => {
    const done = styles(
      buildExportImageTemplate(payload({ items: [{ text: '南極に行く', completed: true }] })),
    )
    const notDone = styles(
      buildExportImageTemplate(payload({ items: [{ text: '南極に行く', completed: false }] })),
    )

    expect(done.some((style) => style.textDecoration === 'line-through')).toBe(true)
    expect(notDone.some((style) => style.textDecoration === 'line-through')).toBe(false)
  })

  it('🔴 作者が載る余地が無い', () => {
    // そもそも ExportImagePayload に入っていないので、書こうと思っても書けない
    const found = texts(buildExportImageTemplate(payload()))

    expect(found.join('')).not.toContain('aiandrox')
  })

  it('項目の上限（22文字）でも列からはみ出さない', () => {
    const longest = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH)
    const found = styles(
      buildExportImageTemplate(payload({ items: [{ text: longest, completed: false }] })),
    )

    // 収まる大きさにしてあるが、**念のため切る**指定が入っていること
    expect(found.some((style) => style.textOverflow === 'ellipsis')).toBe(true)
  })

  it('画像の大きさは約 1.41:1（A4 横に近い）', () => {
    expect(EXPORT_IMAGE_WIDTH / EXPORT_IMAGE_HEIGHT).toBeCloseTo(1.41, 2)
  })

  it('OGP とは別の縦横比（役割が違う）', () => {
    expect(EXPORT_IMAGE_WIDTH / EXPORT_IMAGE_HEIGHT).not.toBeCloseTo(1200 / 630, 2)
  })
})

/**
 * トップページの OGP（#229）。**書き出し画像のデザインを踏襲したもの。**
 *
 * 🔴 見るのは **「見本の文言が列からはみ出さないこと」。**
 * Satori は溢れても切らないので、**長い文言を足しても誰も気づけない。**
 * ここが唯一の歯止め（画像は1枚だけ作ってコミットするので、CI では描かれない）。
 */
describe('buildServiceOgTemplate', () => {
  it('サービス名と一言が載っている', () => {
    const found = texts(buildServiceOgTemplate())

    expect(found).toContain(SERVICE_NAME)
    expect(found).toContain(SERVICE_TAGLINE)
  })

  it('番号付きの行が並ぶ（001 から）', () => {
    const found = texts(buildServiceOgTemplate())

    expect(found).toContain('001')
    expect(found).toContain('048')
  })

  it('「やった」印の付いたものが混ざっている', () => {
    // 全部未完了だと「叶えたら印を付ける」が伝わらない
    const struck = styles(buildServiceOgTemplate()).filter(
      (style) => style.textDecoration === 'line-through',
    )

    expect(struck.length).toBeGreaterThan(0)
    expect(struck.length).toBeLessThan(48 / 2)
  })

  it('🔴 見本の文言が列からはみ出さない', () => {
    const numbers = new Set(Array.from({ length: 48 }, (_, i) => String(i + 1).padStart(3, '0')))
    const samples = texts(buildServiceOgTemplate()).filter(
      (value) => value !== SERVICE_NAME && value !== SERVICE_TAGLINE && !numbers.has(value),
    )

    expect(samples).toHaveLength(48)

    // はみ出したものを**全部**出す（1件ずつ直させない）
    const overflowing = samples.filter((sample) => displayWidth(sample) > SERVICE_OG_TEXT_WIDTH)
    expect(overflowing).toEqual([])
  })

  it('🔴 実在しそうな個人情報を載せない', () => {
    const found = texts(buildServiceOgTemplate()).join('')

    // ここに書いたものが全世界のカードに出る
    expect(found).not.toContain('@')
    expect(found).not.toContain('aiandrox')
  })
})
