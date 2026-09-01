import { buildExportFile, buildMarkdown } from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

/**
 * 見出しの形の実物（#329）。**利用者が示した形と一致していることを固定する。**
 *
 * 🔴 **形を変えるとここが落ちる。** 転載先で節を作る前提の形なので、
 * 見出しの段（`###`）や番号の付け方を勝手に変えない。
 */
describe('見出しの形の実物', () => {
  const file = () =>
    buildExportFile(
      {
        title: '人生でやりたいことリスト',
        items: [
          {
            text: '南極に行く',
            completedAt: new Date('2026-08-01T00:00:00.000Z'),
            completedPrecision: 'day',
            memo: '寒そうだけど一度は見たい。',
          },
          { text: 'オーロラを見る', completedAt: null, completedPrecision: null, memo: null },
        ],
      },
      new Date(0),
    )

  it('リスト名 → 達成数 → やりたいことごとの節', () => {
    const markdown = buildMarkdown(file(), {
      style: 'heading',
      showCompletedDate: true,
      showMemo: true,
    })

    expect(markdown).toBe(
      [
        '## 人生でやりたいことリスト',
        '',
        '1 / 2 達成済み',
        '',
        '### 1. 南極に行く（2026/08/01 達成）',
        '',
        '寒そうだけど一度は見たい。',
        '',
        '### 2. オーロラを見る',
        '',
        '',
      ].join('\n'),
    )
  })

  it('メモを出さなければ、見出しだけが並ぶ', () => {
    const markdown = buildMarkdown(file(), {
      style: 'heading',
      showCompletedDate: false,
      showMemo: false,
    })

    expect(markdown).toBe(
      [
        '## 人生でやりたいことリスト',
        '',
        '1 / 2 達成済み',
        '',
        '### 1. 南極に行く（達成済）',
        '',
        '### 2. オーロラを見る',
        '',
        '',
      ].join('\n'),
    )
  })
})
