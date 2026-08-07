import { exports } from 'cloudflare:workers'
import {
  EXPORT_VERSION,
  buildExportFile,
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
  list: { title: string; items: { text: string; completedAt: string | null }[] }
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
          { text: '南極に行く', completedAt: new Date(1_700_000_000_000) },
          { text: 'オーロラを見る', completedAt: null },
        ],
      },
      new Date(0),
    )

    expect(file.list.items).toEqual([
      { text: '南極に行く', completedAt: new Date(1_700_000_000_000).toISOString() },
      { text: 'オーロラを見る', completedAt: null },
    ])
  })

  it('渡された順のまま。並べ替えない', () => {
    const file = buildExportFile(
      {
        title: 'x',
        items: [
          { text: 'b', completedAt: null },
          { text: 'a', completedAt: null },
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
      { title: '2026年の目標', items: [{ text: '南極に行く', completedAt: new Date(0) }] },
      new Date(1_700_000_000_000),
    )

    expect(exportFileSchema.safeParse(file).success).toBe(true)
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
      })

    const res = await request('/api/lists/my-list/export', { headers: me.headers })
    const body = await res.json<ExportBody>()

    expect(body.list.items[0]?.completedAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('項目が0件でも壊れない', async () => {
    const { me } = await twoUsers()

    const res = await request('/api/lists/my-list/export', { headers: me.headers })
    const body = await res.json<ExportBody>()

    expect(res.status).toBe(200)
    expect(body.list.items).toEqual([])
  })
})
