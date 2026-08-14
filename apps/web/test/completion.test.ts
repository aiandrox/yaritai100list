import {
  COMPLETED_ON_MIN_YEAR,
  COMPLETED_PRECISIONS,
  completedOnSchema,
  formatCompletedOn,
  isCompleted,
  parseCompletedOn,
  toCompletedOn,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

/**
 * 完了日の粒度（#279）。**`packages/shared` の純関数**なので直接テストする。
 *
 * 🔴 **完了日は日本時間の暦日として扱う**（`COMPLETED_ON_TIME_ZONE_OFFSET_MS`）。
 * テストの実行環境の時間帯に左右されないよう、**UTC の瞬間を直に書いて**
 * 日本時間での見え方を固定する（`2025-12-31T15:00:00Z` = 2026-01-01 00:00 JST）。
 *
 * #279 より前にあった `toDateInputValue` / `withDatePart`（端末の時間帯で日付を
 * 組み立てていた）の役目は、ここの `toCompletedOn` / `parseCompletedOn` が引き継いだ。
 */

const jst = (iso: string) => new Date(iso)

describe('isCompleted', () => {
  it('粒度が付いていれば完了。日付なしも完了', () => {
    for (const precision of COMPLETED_PRECISIONS) {
      expect(isCompleted(precision)).toBe(true)
    }
  })

  it('null は未完了', () => {
    expect(isCompleted(null)).toBe(false)
  })
})

describe('parseCompletedOn', () => {
  it('日まで指定すると day。その日の 00:00 JST を持つ', () => {
    const parsed = parseCompletedOn('2026-08-14')

    expect(parsed?.precision).toBe('day')
    expect(parsed?.at.toISOString()).toBe('2026-08-13T15:00:00.000Z')
  })

  it('年月を指定すると month。その月の頭（JST）を持つ', () => {
    const parsed = parseCompletedOn('2026-08')

    expect(parsed?.precision).toBe('month')
    expect(parsed?.at.toISOString()).toBe('2026-07-31T15:00:00.000Z')
  })

  it('年を指定すると year。その年の頭（JST）を持つ', () => {
    const parsed = parseCompletedOn('2026')

    expect(parsed?.precision).toBe('year')
    expect(parsed?.at.toISOString()).toBe('2025-12-31T15:00:00.000Z')
  })

  /**
   * 🔴 **期間の「頭」で持つ理由**（#279）。
   * 末尾（12月31日）にすると、**今年を `year` で記録した瞬間に未来の日時になり、
   * `isFutureCompletedAt` に弾かれる。**
   */
  it('🔴 期間の頭を返す（末尾にしない）', () => {
    const year = parseCompletedOn('2026')
    const month = parseCompletedOn('2026-08')

    expect(toCompletedOn(year?.at ?? null, 'day')).toBe('2026-01-01')
    expect(toCompletedOn(month?.at ?? null, 'day')).toBe('2026-08-01')
  })

  it('🔴 存在しない日・月は null（黙って別の日にしない）', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-01', '2026-08-00', '2026-08-32']) {
      expect(parseCompletedOn(bad)).toBeNull()
    }
  })

  it('🔴 読めない形は null（画面から来る値もファイルの値も信用しない）', () => {
    for (const bad of [
      '',
      '2026-8-14',
      '2026/08/14',
      '2026-08-14T00:00:00.000Z',
      'あした',
      '26-08-14',
      '2026-08-14-01',
    ]) {
      expect(parseCompletedOn(bad)).toBeNull()
    }
  })

  it(`🔴 ${String(COMPLETED_ON_MIN_YEAR)}年より前は null（打ち間違いの箍）`, () => {
    expect(parseCompletedOn('1899')).toBeNull()
    expect(parseCompletedOn('1899-12-31')).toBeNull()
    expect(parseCompletedOn(String(COMPLETED_ON_MIN_YEAR))).not.toBeNull()
  })

  it('うるう日は通る', () => {
    expect(parseCompletedOn('2024-02-29')?.at.toISOString()).toBe('2024-02-28T15:00:00.000Z')
    // 2026年はうるう年ではない
    expect(parseCompletedOn('2026-02-29')).toBeNull()
  })
})

describe('toCompletedOn', () => {
  it('粒度どおりの形にする', () => {
    const at = jst('2026-08-13T15:00:00.000Z') // 2026-08-14 00:00 JST

    expect(toCompletedOn(at, 'day')).toBe('2026-08-14')
    expect(toCompletedOn(at, 'month')).toBe('2026-08')
    expect(toCompletedOn(at, 'year')).toBe('2026')
  })

  it('日付を持たない粒度と未完了は null', () => {
    expect(toCompletedOn(jst('2026-08-13T15:00:00.000Z'), 'unknown')).toBeNull()
    expect(toCompletedOn(null, 'unknown')).toBeNull()
    expect(toCompletedOn(null, null)).toBeNull()
  })

  /**
   * 🔴 **UTC で日付を切らない**（#279 より前の `toDateInputValue` と同じ注意）。
   * 日本時間の朝9時より前に完了した項目が前日として出てしまう。
   */
  it('🔴 日本時間で見た日付になる', () => {
    // UTC では 8/13、日本時間では 8/14
    expect(toCompletedOn(jst('2026-08-13T18:00:00.000Z'), 'day')).toBe('2026-08-14')
    // UTC では 1/1、日本時間では 1/1（9時間の差で年をまたぐ側）
    expect(toCompletedOn(jst('2025-12-31T16:00:00.000Z'), 'year')).toBe('2026')
  })

  it('入れた値がそのまま読み戻せる（往復して動かない）', () => {
    for (const value of [
      '2026-01-01',
      '2026-02-28',
      '2026-12-31',
      '2024-02-29',
      '2026-08',
      '2026',
    ]) {
      const parsed = parseCompletedOn(value)

      expect(parsed).not.toBeNull()
      expect(toCompletedOn(parsed?.at ?? null, parsed?.precision ?? null)).toBe(value)
    }
  })
})

describe('formatCompletedOn', () => {
  const at = jst('2026-08-13T15:00:00.000Z') // 2026-08-14 00:00 JST

  it('粒度ごとに出す情報を変える', () => {
    expect(formatCompletedOn(at, 'day')).toBe('2026/08/14')
    expect(formatCompletedOn(at, 'month')).toBe('2026年8月')
    expect(formatCompletedOn(at, 'year')).toBe('2026年')
  })

  it('🔴 日付なしと未完了は空（「達成済」などを足さない）', () => {
    // 完了は打ち消し線・✓・達成数が伝えている（2026-08-14 の判断）
    expect(formatCompletedOn(null, 'unknown')).toBe('')
    expect(formatCompletedOn(at, 'unknown')).toBe('')
    expect(formatCompletedOn(null, null)).toBe('')
  })

  it('月は0で埋めない（日付だけ埋める）', () => {
    const january = jst('2025-12-31T15:00:00.000Z') // 2026-01-01 00:00 JST

    expect(formatCompletedOn(january, 'month')).toBe('2026年1月')
    expect(formatCompletedOn(january, 'day')).toBe('2026/01/01')
  })
})

describe('completedOnSchema', () => {
  it('3つの形だけを通す', () => {
    for (const value of ['2026', '2026-08', '2026-08-14']) {
      expect(completedOnSchema.safeParse(value).success).toBe(true)
    }
  })

  it('それ以外は通さない', () => {
    for (const value of ['', '26', '2026-8', '2026-08-14T00:00:00Z', '2026-08-14-01']) {
      expect(completedOnSchema.safeParse(value).success).toBe(false)
    }
  })
})
