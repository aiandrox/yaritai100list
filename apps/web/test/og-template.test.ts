import {
  buildOgTemplate,
  LIST_TITLE_MAX_LENGTH,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  SERVICE_NAME,
  type OgElement,
  type OgPayload,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

/**
 * OGP のレイアウトのテスト（#172）。
 *
 * Satori に渡すのは**ただのオブジェクト**なので、Deno を持ち出さずにここで固定できる。
 * 見た目そのものは目で見るしかないが、**「何が載っているか」は型と構造で守れる。**
 */

function payload(overrides: Partial<OgPayload> = {}): OgPayload {
  return { title: '2026年の目標', completed: 5, filled: 23, exp: 1, ...overrides }
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

describe('buildOgTemplate', () => {
  it('タイトルと達成状況とサービス名が載る', () => {
    const found = texts(buildOgTemplate(payload()))

    expect(found).toContain('2026年の目標')
    expect(found).toContain('5')
    expect(found).toContain('/ 23')
    expect(found).toContain(SERVICE_NAME)
  })

  it('🔴 載っているのはこれだけ（項目の一覧も作者も無い）', () => {
    // OGP はタイトルと達成状況だけ。一覧は画像出力（#9）の役割（PRODUCT_SPEC.md §5.2）。
    // **増えたら落ちる**形にしてある。渡す型に項目も作者も無いので、そもそも載せようがない
    expect(texts(buildOgTemplate(payload()))).toEqual([
      SERVICE_NAME,
      '2026年の目標',
      '5',
      '/ 23',
      'やった',
    ])
  })

  it('🔴 grid を使っていない（Satori が対応していない）', () => {
    // TECH_STACK.md §4.3。対応範囲内でデザインする、と決めてある
    const displays = styles(buildOgTemplate(payload())).map((style) => style.display)

    expect(displays.every((display) => display === 'flex')).toBe(true)
  })

  it('進み具合の帯が達成の割合になる', () => {
    const widths = styles(buildOgTemplate(payload({ completed: 1, filled: 4 })))
      .map((style) => style.width)
      .filter((width) => typeof width === 'string' && width.endsWith('%'))

    expect(widths).toContain('25%')
  })

  it('🔴 1件も書いていなくても壊れない（0 で割らない）', () => {
    const widths = styles(buildOgTemplate(payload({ completed: 0, filled: 0 })))
      .map((style) => style.width)
      .filter((width) => typeof width === 'string' && width.endsWith('%'))

    expect(widths).toContain('0%')
  })

  it('長いタイトルでも組み立てられる', () => {
    const title = 'あ'.repeat(LIST_TITLE_MAX_LENGTH)

    expect(texts(buildOgTemplate(payload({ title })))).toContain(title)
  })

  it('画像の大きさが SNS のカードの比率', () => {
    // 1200x630（約 1.91:1）
    expect(OG_IMAGE_WIDTH / OG_IMAGE_HEIGHT).toBeCloseTo(1.9, 1)
  })
})
