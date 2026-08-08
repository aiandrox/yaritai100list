import { exports } from 'cloudflare:workers'
import { OG_SIGNATURE_TTL_SECONDS } from '@yaritai100list/shared'
import { describe, expect, it, vi } from 'vitest'

import { buildOgPayload, cacheControlFor, ogImageUrl, renderRequestUrl } from '../src/og'
import { lists } from '../src/db/schema'
import { createTestUser, testBaseUrl, testDb } from './helpers'

/**
 * OGP 画像の入口のテスト（#171）。
 *
 * 🔴 見るのは **「非公開の画像が出ないこと」** が中心。
 * 「画像だけ漏れる」は典型的な事故（`CLAUDE.md` の不変条件）。
 *
 * 画像そのものは Deno Deploy 側（#172）。**まだ無いので 503 が正しい応答。**
 */

const request = (path: string) => exports.default.fetch(new Request(`${testBaseUrl()}${path}`))

async function createList(options: {
  visibility: 'private' | 'unlisted' | 'public'
  title?: string
}) {
  const db = testDb()
  const userId = await createTestUser(`${crypto.randomUUID()}@example.com`)
  const id = crypto.randomUUID()
  const shareId = crypto.randomUUID().replaceAll('-', '')

  await db.insert(lists).values({
    id,
    userId,
    title: options.title ?? '2026年の目標',
    shareId,
    visibility: options.visibility,
  })

  return { id, shareId }
}

describe('buildOgPayload', () => {
  const now = new Date('2026-08-08T00:00:00.000Z')

  it('達成状況を数える。分母は書いた数', () => {
    const payload = buildOgPayload(
      { title: '2026年の目標' },
      [{ completedAt: new Date() }, { completedAt: null }, { completedAt: new Date() }],
      now,
    )

    expect(payload.title).toBe('2026年の目標')
    expect(payload.completed).toBe(2)
    expect(payload.filled).toBe(3)
  })

  it('期限が入る', () => {
    const payload = buildOgPayload({ title: 'x' }, [], now)

    expect(payload.exp).toBe(Math.floor(now.getTime() / 1000) + OG_SIGNATURE_TTL_SECONDS)
  })

  it('🔴 作者を入れる場所が無い', () => {
    // 型で守っている。渡す値を増やしても入らない
    expect(Object.keys(buildOgPayload({ title: 'x' }, [], now)).sort()).toEqual([
      'completed',
      'exp',
      'filled',
      'title',
    ])
  })
})

describe('renderRequestUrl', () => {
  it('署名を含む URL を組み立てる', () => {
    const url = renderRequestUrl(
      'https://render.example.com',
      { title: 'あ い', completed: 1, filled: 2, exp: 123 },
      'sig',
    )

    expect(url.startsWith('https://render.example.com/og?')).toBe(true)
    expect(new URL(url).searchParams.get('title')).toBe('あ い')
    expect(new URL(url).searchParams.get('sig')).toBe('sig')
  })

  it('末尾のスラッシュがあっても二重にならない', () => {
    const url = renderRequestUrl(
      'https://render.example.com/',
      {
        title: 'x',
        completed: 0,
        filled: 0,
        exp: 1,
      },
      'sig',
    )

    expect(url).toContain('.com/og?')
  })
})

describe('ogImageUrl', () => {
  it('🔴 更新日時が入る（入らないと SNS が古い画像を出し続ける）', () => {
    const url = ogImageUrl('https://example.com', 'abc123', new Date('2026-08-08T00:00:00.000Z'))

    expect(url).toBe('https://example.com/og/abc123?v=1786147200000')
  })

  it('🔴 更新すると別の URL になる', () => {
    const at = (iso: string) => ogImageUrl('https://example.com', 'abc123', new Date(iso))

    expect(at('2026-08-08T00:00:00.000Z')).not.toBe(at('2026-08-08T00:00:01.000Z'))
  })

  it('絶対 URL にする（SNS は相対パスを解決しない）', () => {
    expect(ogImageUrl('https://example.com', 'x', new Date(0))).toMatch(/^https:\/\//)
  })

  // `v` が付くので、この URL は恒久キャッシュになる（`cacheControlFor`）
  it('cacheControlFor が恒久キャッシュと判断する形になっている', () => {
    const version = new URL(ogImageUrl('https://example.com', 'x', new Date(1))).searchParams.get(
      'v',
    )

    expect(cacheControlFor(version ?? undefined)).toContain('immutable')
  })
})

describe('cacheControlFor', () => {
  it('🔴 v が付いているときだけ恒久キャッシュ', () => {
    // v が無い URL は更新しても直らなくなるので、短くしておく
    expect(cacheControlFor('123')).toContain('immutable')
    expect(cacheControlFor(undefined)).not.toContain('immutable')
    expect(cacheControlFor('')).not.toContain('immutable')
  })
})

describe('GET /og/:shareId', () => {
  it('🔴 非公開のリストの画像は出ない', async () => {
    const list = await createList({ visibility: 'private' })

    expect((await request(`/og/${list.shareId}`)).status).toBe(404)
  })

  it('🔴 非公開と、存在しない ID で応答が完全に一致する', async () => {
    const list = await createList({ visibility: 'private' })

    const hidden = await request(`/og/${list.shareId}`)
    const missing = await request('/og/no-such-share-id')

    expect(hidden.status).toBe(missing.status)
    expect(await hidden.text()).toBe(await missing.text())
  })

  it('🔴 編集用の ID を渡しても出ない', async () => {
    const list = await createList({ visibility: 'public' })

    expect((await request(`/og/${list.id}`)).status).toBe(404)
  })

  it('公開されていれば 404 にはならない', async () => {
    // 生成サービスがまだ無いので 503。**認可は通っている**ことの確認
    const list = await createList({ visibility: 'unlisted' })

    const res = await request(`/og/${list.shareId}`)

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Image Not Available' })
  })

  it('出せなかった理由がログに残る（応答には出さない）', async () => {
    // ⚠️ 「繋がらない」も「鍵が違う」も同じ 503 なので、
    // ログが無いと**どちらなのか分からない**（#174 で実際に詰まった）
    const list = await createList({ visibility: 'unlisted' })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await request(`/og/${list.shareId}`)

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('og:'))
    // 🔴 理由は利用者に返さない（非公開かどうかの手がかりを増やさない）
    expect(await res.json()).toEqual({ error: 'Image Not Available' })

    logged.mockRestore()
  })

  it('🔴 鍵が未設定なら画像を出さない', async () => {
    // **署名なしで叩ける状態を作らない**（TECH_STACK.md §9）。
    // テスト環境に RENDER_HMAC_SECRET は無い（.dev.vars も CI も入れていない）
    const list = await createList({ visibility: 'public' })

    expect((await request(`/og/${list.shareId}`)).status).toBe(503)
  })
})
