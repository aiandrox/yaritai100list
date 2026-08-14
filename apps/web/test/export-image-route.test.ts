import { exports } from 'cloudflare:workers'
import {
  EXPORT_IMAGE_SIGNATURE_HEADER,
  EXPORT_IMAGE_SIGNATURE_TTL_SECONDS,
} from '@yaritai100list/shared'
import { describe, expect, it, vi } from 'vitest'

import { items, lists } from '../src/db/schema'
import { buildExportImagePayload, exportImageRequest } from '../src/export-image'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * ダウンロード画像の入口のテスト（#192）。
 *
 * 🔴 見るのは **「他人のリストの画像が出ないこと」** と
 * **「誰でも叩ける状態になっていないこと」**（`TECH_STACK.md` §9）。
 *
 * 画像そのものは Deno Deploy 側（#191）。**テスト環境には無いので 503 が正しい応答。**
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

/**
 * 制限に当たるまで叩くのを諦める回数（#215）。
 *
 * **テストが使う枠は本番より小さい**（`vitest.config.ts` の `ratelimits`）。
 * 枠より十分大きく、しかし小さく。**大きくすると、制限が壊れたときに遅く落ちる。**
 */
const GIVE_UP_AT = 15

/** ログイン済みの利用者としてリストを1つ作る。 */
async function createList(headers: Headers, userId: string, rows: string[] = ['南極に行く']) {
  const db = testDb()
  const id = crypto.randomUUID()

  await db.insert(lists).values({
    id,
    userId,
    title: '人生でやりたいことリスト',
    shareId: crypto.randomUUID().replaceAll('-', ''),
  })

  if (rows.length > 0) {
    await db.insert(items).values(
      rows.map((text, position) => ({
        id: crypto.randomUUID(),
        listId: id,
        text,
        position,
        // 粒度も一緒に入れる（#279。DB が組み合わせを縛っている）
        completedAt: position === 0 ? new Date() : null,
        completedPrecision: position === 0 ? ('day' as const) : null,
      })),
    )
  }

  return { id, headers }
}

const imageRequest = (listId: string, headers?: Headers) =>
  request(
    `/api/lists/${listId}/image`,
    headers === undefined ? undefined : { headers: Object.fromEntries(headers) },
  )

describe('buildExportImagePayload', () => {
  const now = new Date('2026-08-08T00:00:00.000Z')

  it('「やった」印を真偽値にする（日時は画像に出さない）', () => {
    const payload = buildExportImagePayload(
      { title: '人生でやりたいことリスト' },
      [
        { text: '南極に行く', completedPrecision: 'day' },
        { text: 'オーロラを見る', completedPrecision: null },
      ],
      now,
    )

    expect(payload.title).toBe('人生でやりたいことリスト')
    expect(payload.items).toEqual([
      { text: '南極に行く', completed: true },
      { text: 'オーロラを見る', completed: false },
    ])
  })

  // 🔴 日付なしの完了（#279）が画像の上で未完了になっていないこと
  it('日付を覚えていない完了も「やった」印が付く', () => {
    const payload = buildExportImagePayload(
      { title: '人生でやりたいことリスト' },
      [{ text: '南極に行く', completedPrecision: 'unknown' }],
      now,
    )

    expect(payload.items).toEqual([{ text: '南極に行く', completed: true }])
  })

  it('期限が入る', () => {
    const payload = buildExportImagePayload({ title: 'x' }, [], now)

    expect(payload.exp).toBe(Math.floor(now.getTime() / 1000) + EXPORT_IMAGE_SIGNATURE_TTL_SECONDS)
  })

  it('🔴 作者が入る余地が無い', () => {
    const payload = buildExportImagePayload({ title: 'x' }, [], now)

    expect(Object.keys(payload).sort()).toEqual(['exp', 'items', 'title'])
  })
})

describe('exportImageRequest', () => {
  const payload = { title: 'x', items: [], exp: 1 }

  it('POST で /export に送る', () => {
    const built = exportImageRequest('https://example.com', payload, 'abc')

    expect(built.method).toBe('POST')
    expect(built.url).toBe('https://example.com/export')
  })

  it('🔴 署名はヘッダに載せる（URL には載らない）', () => {
    const built = exportImageRequest('https://example.com', payload, 'abc')

    expect(built.headers.get(EXPORT_IMAGE_SIGNATURE_HEADER)).toBe('abc')
    expect(built.url).not.toContain('abc')
  })

  it('末尾のスラッシュがあっても壊れない', () => {
    expect(exportImageRequest('https://example.com/', payload, 'x').url).toBe(
      'https://example.com/export',
    )
  })
})

describe('GET /api/lists/:listId/image', () => {
  it('🔴 未ログインでは出ない', async () => {
    const owner = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(owner.headers, owner.userId)

    expect((await imageRequest(list.id)).status).toBe(401)
  })

  it('🔴 他人のリストでは出ない', async () => {
    const owner = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(owner.headers, owner.userId)
    const stranger = await signIn(`${crypto.randomUUID()}@example.com`)

    expect((await imageRequest(list.id, stranger.headers)).status).toBe(404)
  })

  it('🔴 他人のリストと、存在しない ID で応答が完全に一致する', async () => {
    // 出し分けると「その ID は存在する」ことが分かってしまう
    const owner = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(owner.headers, owner.userId)
    const stranger = await signIn(`${crypto.randomUUID()}@example.com`)

    const other = await imageRequest(list.id, stranger.headers)
    const missing = await imageRequest('no-such-list-id', stranger.headers)

    expect(other.status).toBe(missing.status)
    expect(await other.text()).toBe(await missing.text())
  })

  it('自分のリストなら 404 にはならない', async () => {
    // 生成サービスがテスト環境に無いので 503。**認可は通っている**ことの確認
    const owner = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(owner.headers, owner.userId)

    const res = await imageRequest(list.id, owner.headers)

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Image Not Available' })
  })

  it('出せなかった理由がログに残る（応答には出さない）', async () => {
    const owner = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(owner.headers, owner.userId)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await imageRequest(list.id, owner.headers)

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('export:'))
    expect(await res.json()).toEqual({ error: 'Image Not Available' })

    logged.mockRestore()
  })

  it('🔴 叩き続けると 429 が返る（作成系より厳しい枠）', async () => {
    // 1回で100項目をラスタライズするので、他の操作とは重さが桁違い
    const me = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(me.headers, me.userId)

    let limited: Response | null = null
    for (let i = 0; i < GIVE_UP_AT; i++) {
      const res = await imageRequest(list.id, me.headers)
      if (res.status === 429) {
        limited = res
        break
      }
    }

    expect(limited).not.toBeNull()
    expect(await limited?.json()).toEqual({ error: 'Too Many Requests' })
  })

  it('🔴 制限の枠が作成系と分かれている（画像を連打しても編集は止まらない）', async () => {
    const me = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(me.headers, me.userId)

    for (let i = 0; i < GIVE_UP_AT; i++) {
      if ((await imageRequest(list.id, me.headers)).status === 429) break
    }

    // 同じ枠にすると、ここが 429 になる
    const created = await request('/api/lists', {
      method: 'POST',
      headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
      body: '{}',
    })

    expect(created.status).toBe(201)
  })

  it('1件も書いていなくても認可は通る', async () => {
    const owner = await signIn(`${crypto.randomUUID()}@example.com`)
    const list = await createList(owner.headers, owner.userId, [])

    expect((await imageRequest(list.id, owner.headers)).status).toBe(503)
  })
})
