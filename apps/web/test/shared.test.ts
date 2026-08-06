import {
  DEFAULT_LIST_TITLE,
  ITEM_TEXT_MAX_LENGTH,
  itemTextSchema,
  LIST_TITLE_MAX_LENGTH,
  listTitleSchema,
  visibilitySchema,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

/**
 * `packages/shared` のテストをここに置いている理由:
 * shared は純粋な TypeScript で Workers 固有の API を使わないため、
 * テストランナーを2つ用意する意味が薄い。
 *
 * ただし shared は Deno（画像生成）からも使うので、**このテストが通っても
 * Deno で動くことの保証にはならない**（`TECH_STACK.md` §12）。
 */
describe('文字数の上限', () => {
  it('上限値は 22 文字 / 15 文字（変えるときは PRODUCT_SPEC.md §7 も直す）', () => {
    expect(ITEM_TEXT_MAX_LENGTH).toBe(22)
    expect(LIST_TITLE_MAX_LENGTH).toBe(15)
  })

  it('上限ちょうどは通り、1文字超えると弾かれる', () => {
    expect(listTitleSchema.safeParse('あ'.repeat(LIST_TITLE_MAX_LENGTH)).success).toBe(true)
    expect(listTitleSchema.safeParse('あ'.repeat(LIST_TITLE_MAX_LENGTH + 1)).success).toBe(false)

    expect(itemTextSchema.safeParse('あ'.repeat(ITEM_TEXT_MAX_LENGTH)).success).toBe(true)
    expect(itemTextSchema.safeParse('あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1)).success).toBe(false)
  })

  it('前後の空白は取り除かれる', () => {
    expect(itemTextSchema.parse('  富士山に登る  ')).toBe('富士山に登る')
  })

  it('空文字と空白だけの入力は弾かれる', () => {
    expect(itemTextSchema.safeParse('').success).toBe(false)
    expect(itemTextSchema.safeParse('   ').success).toBe(false)
  })

  it('文字数は UTF-16 のコード単位で数える（絵文字は複数文字として扱う）', () => {
    // 👨‍👩‍👧‍👦 は見た目1文字だが 11 コード単位。
    // 上限はレイアウト崩れと CPU 消費を防ぐための箍なので、
    // 見た目の文字数で数えると箍として機能しない
    const family = '👨‍👩‍👧‍👦'
    expect(family.length).toBe(11)

    expect(itemTextSchema.safeParse(family.repeat(2)).success).toBe(true) // 22
    expect(itemTextSchema.safeParse(family.repeat(3)).success).toBe(false) // 33
  })

  it('既定のリストタイトルが自分の上限に収まっている', () => {
    // 既定値が自分のバリデーションを通らないと、リスト作成が必ず失敗する
    expect(listTitleSchema.safeParse(DEFAULT_LIST_TITLE).success).toBe(true)
  })
})

describe('公開範囲', () => {
  it('3つの値だけを受け付ける', () => {
    expect(visibilitySchema.safeParse('private').success).toBe(true)
    expect(visibilitySchema.safeParse('unlisted').success).toBe(true)
    expect(visibilitySchema.safeParse('public').success).toBe(true)
  })

  it('知らない値は弾かれる', () => {
    expect(visibilitySchema.safeParse('everyone').success).toBe(false)
    expect(visibilitySchema.safeParse('').success).toBe(false)
  })
})
