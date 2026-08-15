import { exports } from 'cloudflare:workers'
import {
  type CompletedPrecision,
  completedPrecisionOf,
  DEFAULT_MARKDOWN_OPTIONS,
  EXPORT_VERSION,
  ITEMS_PER_LIST_MAX,
  buildExportFile,
  buildMarkdown,
  exportFileName,
  exportFileSchema,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * リストの書き出しのテスト（#121）。
 *
 * 組み立ては `packages/shared` の純関数なので、そちらは直接テストする。
 * API 側は**認可**（他人のリストを持ち出せない）を中心に見る。
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

interface ExportBody {
  version: number
  exportedAt: string
  list: {
    title: string
    items: { text: string; completedAt: string | null; completedPrecision: string | null }[]
  }
}

async function twoUsers() {
  const me = await signIn('me@example.com')
  const other = await signIn('other@example.com')

  await testDb()
    .insert(lists)
    .values([
      { id: 'my-list', userId: me.userId, title: '自分のリスト' },
      { id: 'other-list', userId: other.userId, title: '他人のリスト' },
    ])

  return { me, other }
}

describe('buildExportFile', () => {
  it('版と書き出した時刻を持つ', () => {
    const file = buildExportFile({ title: 'x', items: [] }, new Date(1_700_000_000_000))

    expect(file.version).toBe(EXPORT_VERSION)
    expect(file.exportedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('🔴 完了日時を含める（落とすと持ち出す意味が無くなる）', () => {
    const file = buildExportFile(
      {
        title: 'x',
        items: [
          {
            text: '南極に行く',
            completedAt: new Date(1_700_000_000_000),
            completedPrecision: 'day',
            memo: null,
          },
          { text: 'オーロラを見る', completedAt: null, completedPrecision: null, memo: null },
        ],
      },
      new Date(0),
    )

    expect(file.list.items).toEqual([
      {
        text: '南極に行く',
        completedAt: new Date(1_700_000_000_000).toISOString(),
        completedPrecision: 'day',
        memo: null,
      },
      { text: 'オーロラを見る', completedAt: null, completedPrecision: null, memo: null },
    ])
  })

  /**
   * 🔴 **JSON にはメモを入れる**（#294）。ここだけが入れる側。
   * 落とすと、書き出して取り込んだときに**メモだけが消える。**
   */
  it('🔴 メモを含める（落とすと往復でメモだけ消える）', () => {
    const file = buildExportFile(
      {
        title: 'x',
        items: [
          { text: '南極に行く', completedAt: null, completedPrecision: null, memo: '寒そう' },
          { text: 'オーロラを見る', completedAt: null, completedPrecision: null, memo: null },
        ],
      },
      new Date(0),
    )

    expect(file.list.items.map((item) => item.memo)).toEqual(['寒そう', null])
  })

  // 🔴 落とすと、日付なしの完了が読み込んだ先で未完了になる（#279）
  it('🔴 粒度を含める。日付なしの完了は日時が無いまま完了として出る', () => {
    const file = buildExportFile(
      {
        title: 'x',
        items: [
          { text: '南極に行く', completedAt: null, completedPrecision: 'unknown', memo: null },
        ],
      },
      new Date(0),
    )

    expect(file.list.items).toEqual([
      { text: '南極に行く', completedAt: null, completedPrecision: 'unknown', memo: null },
    ])
    expect(exportFileSchema.safeParse(file).success).toBe(true)
  })

  it('🔴 粒度と完了日時が食い違うファイルは読み込まない', () => {
    // 手で編集したファイルを通すと、DB のトリガー（0016）に弾かれて 500 になる
    for (const item of [
      { text: 'x', completedAt: null, completedPrecision: 'day' },
      { text: 'x', completedAt: new Date(0).toISOString(), completedPrecision: 'unknown' },
      { text: 'x', completedAt: new Date(0).toISOString(), completedPrecision: null },
    ]) {
      const file = {
        version: EXPORT_VERSION,
        exportedAt: new Date(0).toISOString(),
        list: { title: 'x', items: [item] },
      }

      expect(exportFileSchema.safeParse(file).success).toBe(false)
    }
  })

  describe('completedPrecisionOf（粒度を持たない古いファイル。#279）', () => {
    it('完了日時があれば day', () => {
      expect(completedPrecisionOf({ text: 'x', completedAt: new Date(0).toISOString() })).toBe(
        'day',
      )
    })

    it('完了日時が無ければ未完了', () => {
      expect(completedPrecisionOf({ text: 'x', completedAt: null })).toBeNull()
    })

    it('粒度があればそちらを使う', () => {
      expect(
        completedPrecisionOf({
          text: 'x',
          completedAt: null,
          completedPrecision: 'unknown',
          memo: null,
        }),
      ).toBe('unknown')
    })
  })

  it('渡された順のまま。並べ替えない', () => {
    const file = buildExportFile(
      {
        title: 'x',
        items: [
          { text: 'b', completedAt: null, completedPrecision: null, memo: null },
          { text: 'a', completedAt: null, completedPrecision: null, memo: null },
        ],
      },
      new Date(0),
    )

    expect(file.list.items.map((item) => item.text)).toEqual(['b', 'a'])
  })

  it('🔴 書き出したものが、読み込み側のスキーマを通る', () => {
    // 通らないと、自分で書き出したファイルを自分で読めない（#122）。
    // 版・日時の形式・文字数の上限まで含めて、ここで往復を固定する
    const file = buildExportFile(
      {
        title: '2026年の目標',
        items: [
          { text: '南極に行く', completedAt: new Date(0), completedPrecision: 'day', memo: null },
        ],
      },
      new Date(1_700_000_000_000),
    )

    expect(exportFileSchema.safeParse(file).success).toBe(true)
  })
})

describe('buildMarkdown', () => {
  /**
   * 粒度は省略できる。**日時があれば `day`**（#279 より前と同じ意味）。
   * 日付なしの完了を作るときだけ `'unknown'` を明示する
   */
  const file = (
    items: { text: string; completedAt: string | null; completedPrecision?: CompletedPrecision }[],
  ) =>
    buildExportFile(
      {
        title: '2026年の目標',
        items: items.map((item) => ({
          text: item.text,
          completedAt: item.completedAt === null ? null : new Date(item.completedAt),
          completedPrecision: item.completedPrecision ?? (item.completedAt === null ? null : 'day'),
          // マークダウンにメモは出さない（#294）。ここでは常に空
          memo: null,
        })),
      },
      new Date(0),
    )

  it('見出し・達成の数・チェックリストで出る', () => {
    const markdown = buildMarkdown(
      file([
        { text: '南極に行く', completedAt: '2026-05-01T00:00:00.000Z' },
        { text: 'オーロラを見る', completedAt: null },
      ]),
    )

    expect(markdown).toBe(
      [
        '## 2026年の目標',
        '',
        '1 / 2 達成済み',
        '',
        '- [x] 南極に行く（2026/05/01 達成）',
        '- [ ] オーロラを見る',
        '',
      ].join('\n'),
    )
  })

  it('🔴 数字は「達成済み / 入力済み」。画面の埋まり具合とは意図が違う', () => {
    // 画面は「まだ埋まっていない」という動機を出すために 入力済み / 100 を出すが、
    // 転載を読む人が知りたいのは**どれだけ叶えたか**（#129）
    const markdown = buildMarkdown(
      file([
        { text: 'a', completedAt: '2026-05-01T00:00:00.000Z' },
        { text: 'b', completedAt: '2026-05-02T00:00:00.000Z' },
        { text: 'c', completedAt: null },
      ]),
    )

    expect(markdown).toContain('2 / 3 達成済み')
    // 分母は 100 ではなく、実際に書いた数
    expect(markdown).not.toContain(String(ITEMS_PER_LIST_MAX))
  })

  it('🔴 見出しは `##`（転載先の記事にはすでに `#` がある）', () => {
    expect(buildMarkdown(file([])).startsWith('## ')).toBe(true)
  })

  it('🔴 既定では番号を振らない（#209 で選べるようにしたが、既定は変えていない）', () => {
    const markdown = buildMarkdown(file([{ text: '南極に行く', completedAt: null }]))

    expect(markdown).not.toContain('001')
    expect(markdown).not.toMatch(/^1\./m)
  })

  it('🔴 未入力の枠を出さない（100行の空行は転載に向かない）', () => {
    const markdown = buildMarkdown(file([{ text: '南極に行く', completedAt: null }]))

    expect(markdown.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1)
  })

  it('末尾が改行で終わる（貼った先で次の行とくっつかない）', () => {
    expect(buildMarkdown(file([])).endsWith('\n')).toBe(true)
  })

  // 🔴 **日本時間の暦日で出す**（2026-08-14 の判断、#279）。
  // 以前は整形を外から受け取っていたが、画面・共有ページと同じ文字列にした
  it('日本時間の暦日で出す（UTC で日付を切らない）', () => {
    // UTC では 5/1、日本時間では 5/2
    const markdown = buildMarkdown(file([{ text: 'x', completedAt: '2026-05-01T15:00:00.000Z' }]))

    expect(markdown).toContain('（2026/05/02 達成）')
  })

  /**
   * 🔴 **マークダウンにメモを出さない**（#294、`PRODUCT_SPEC.md` §4.4 の表）。
   * これは**ブログなどに貼る、人に見せるためのもの。** 自分だけのメモは載せない。
   */
  it('🔴 メモを出さない（人に見せるためのものなので）', () => {
    const built = buildExportFile(
      {
        title: 'x',
        items: [
          {
            text: '南極に行く',
            completedAt: null,
            completedPrecision: null,
            memo: 'ここは自分だけのメモ',
          },
        ],
      },
      new Date(0),
    )

    const markdown = buildMarkdown(built)

    expect(markdown).toContain('南極に行く')
    expect(markdown).not.toContain('ここは自分だけのメモ')
  })

  describe('粒度どおりに出す（#279）', () => {
    it('年だけ・年月だけの完了は、その単位で出る', () => {
      const markdown = buildMarkdown(
        file([
          // 2026-01-01 00:00 JST / 2026-08-01 00:00 JST
          { text: '年だけ', completedAt: '2025-12-31T15:00:00.000Z', completedPrecision: 'year' },
          {
            text: '年月だけ',
            completedAt: '2026-07-31T15:00:00.000Z',
            completedPrecision: 'month',
          },
        ]),
      )

      expect(markdown).toContain('- [x] 年だけ（2026年 達成）')
      expect(markdown).toContain('- [x] 年月だけ（2026年8月 達成）')
    })

    it('🔴 日付なしの完了も達成数に入り、`- [x]` が付く', () => {
      const markdown = buildMarkdown(
        file([
          { text: '日付なし', completedAt: null, completedPrecision: 'unknown' },
          { text: '未完了', completedAt: null },
        ]),
      )

      expect(markdown).toContain('1 / 2 達成済み')
      // 日付の欄には何も足さない（2026-08-14 の判断）
      expect(markdown).toContain('- [x] 日付なし\n')
      expect(markdown).toContain('- [ ] 未完了')
    })

    it('🔴 連番のときは、日付なしの完了に `（達成済）` が付く', () => {
      // 連番には `- [x]` にあたるものが無いので、これが無いと完了が消える（#209）
      const markdown = buildMarkdown(
        file([{ text: '日付なし', completedAt: null, completedPrecision: 'unknown' }]),
        { style: 'numbered', showCompletedDate: true },
      )

      expect(markdown).toContain('1. 日付なし（達成済）')
    })
  })

  describe('形式を選ぶ（#209）', () => {
    /** 完了と未完了を1つずつ。**完了だけ見ると「未完了と区別が付くか」が分からない** */
    const both = () =>
      file([
        { text: 'グランピング', completedAt: '2026-08-08T00:00:00.000Z' },
        { text: 'オーロラを見る', completedAt: null },
      ])

    /** 見出し・空行・数の行を落として、項目の行だけ見る */
    const rows = (markdown: string) =>
      markdown
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('## ') && !line.endsWith('達成済み'))

    it('既定は #124 の出力そのまま（チェックリスト・達成日あり）', () => {
      expect(buildMarkdown(both(), DEFAULT_MARKDOWN_OPTIONS)).toBe(buildMarkdown(both()))
    })

    it('チェックリスト × 達成日あり', () => {
      const markdown = buildMarkdown(both(), {
        style: 'checklist',
        showCompletedDate: true,
      })

      expect(rows(markdown)).toEqual([
        '- [x] グランピング（2026/08/08 達成）',
        '- [ ] オーロラを見る',
      ])
    })

    it('チェックリスト × 達成日なし（`- [x]` が残るので、何も足さない）', () => {
      const markdown = buildMarkdown(both(), {
        style: 'checklist',
        showCompletedDate: false,
      })

      expect(rows(markdown)).toEqual(['- [x] グランピング', '- [ ] オーロラを見る'])
    })

    it('連番 × 達成日あり。番号は1から通しで振る（未完了も数える）', () => {
      const markdown = buildMarkdown(both(), {
        style: 'numbered',
        showCompletedDate: true,
      })

      expect(rows(markdown)).toEqual(['1. グランピング（2026/08/08 達成）', '2. オーロラを見る'])
    })

    it('🔴 連番 × 達成日なしのとき、完了した項目に `（達成済）` が付く', () => {
      // 連番には `- [x]` にあたるものが無い。**日付まで消すと、
      // 完了かどうかを表す手段が行から全部無くなる**
      const markdown = buildMarkdown(both(), {
        style: 'numbered',
        showCompletedDate: false,
      })

      expect(rows(markdown)).toEqual(['1. グランピング（達成済）', '2. オーロラを見る'])
    })

    it('数の行は形式で変えない', () => {
      for (const style of ['checklist', 'numbered'] as const) {
        for (const showCompletedDate of [true, false]) {
          expect(buildMarkdown(both(), { style, showCompletedDate })).toContain('1 / 2 達成済み')
        }
      }
    })
  })
})

describe('exportFileName', () => {
  it('リスト名と日付が入る', () => {
    expect(exportFileName('2026年の目標', new Date('2026-08-07T12:00:00.000Z'))).toBe(
      '2026年の目標-2026-08-07.json',
    )
  })

  it('ファイル名に使えない文字を落とす', () => {
    expect(exportFileName('a/b:c', new Date('2026-08-07T00:00:00.000Z'))).toBe(
      'abc-2026-08-07.json',
    )
  })

  it('落とした結果が空なら既定の名前になる', () => {
    expect(exportFileName('///', new Date('2026-08-07T00:00:00.000Z'))).toBe('list-2026-08-07.json')
  })

  it('拡張子を選べる（画像は png。#193）', () => {
    // 画像だけ中身の作り方が違う（サーバーで作る）が、名前の付け方は揃える
    expect(exportFileName('2026年の目標', new Date('2026-08-07T00:00:00.000Z'), 'png')).toBe(
      '2026年の目標-2026-08-07.png',
    )
  })
})

describe('GET /api/lists/:listId/export', () => {
  it('🔴 未ログインでは書き出せない', async () => {
    await twoUsers()

    const res = await request('/api/lists/my-list/export')

    expect(res.status).toBe(401)
  })

  it('🔴 他人のリストは書き出せない。存在しない ID と応答が一致する', async () => {
    const { me } = await twoUsers()

    const others = await request('/api/lists/other-list/export', { headers: me.headers })
    const missing = await request('/api/lists/no-such/export', { headers: me.headers })

    expect(others.status).toBe(404)
    expect(await others.text()).toBe(await missing.text())
  })

  it('項目が並び順で出る', async () => {
    const { me } = await twoUsers()

    await testDb()
      .insert(items)
      .values([
        { id: 'i2', listId: 'my-list', text: '2つ目', position: 1 },
        { id: 'i1', listId: 'my-list', text: '1つ目', position: 0 },
      ])

    const res = await request('/api/lists/my-list/export', { headers: me.headers })
    const body = await res.json<ExportBody>()

    expect(body.list.title).toBe('自分のリスト')
    expect(body.list.items.map((item) => item.text)).toEqual(['1つ目', '2つ目'])
  })

  it('完了日時が入る', async () => {
    const { me } = await twoUsers()

    await testDb()
      .insert(items)
      .values({
        id: 'i1',
        listId: 'my-list',
        text: '南極に行く',
        position: 0,
        completedAt: new Date(1_700_000_000_000),
        completedPrecision: 'day',
        memo: null,
      })

    const res = await request('/api/lists/my-list/export', { headers: me.headers })
    const body = await res.json<ExportBody>()

    expect(body.list.items[0]?.completedAt).toBe(new Date(1_700_000_000_000).toISOString())
    // 粒度も書き出す（#279）。落とすと読み込んだ先で日付なしの完了が未完了になる
    expect(body.list.items[0]?.completedPrecision).toBe('day')
  })

  it('項目が0件でも壊れない', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists/my-list/export', { headers: me.headers })
    const body = await res.json<ExportBody>()

    expect(res.status).toBe(200)
    expect(body.list.items).toEqual([])
  })
})
