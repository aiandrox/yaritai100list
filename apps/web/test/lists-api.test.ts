import { exports } from 'cloudflare:workers'
import {
  LISTS_PER_USER_MAX,
  DEFAULT_LIST_TITLE,
  LIST_TITLE_MAX_LENGTH,
} from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * リストの作成 API のテスト（#88）。
 *
 * 認可の「通らないこと」は `authorization.test.ts` と同じ書き方で入れる
 * （`docs/workflow.md` §6）。成功パスだけにしない。
 */

// オリジンは Worker の BETTER_AUTH_URL に揃える（Cookie 名と Origin チェックのため）
const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

/** ログイン済みの利用者としてリストを作る。 */
function createList(headers: Headers, body: unknown = {}) {
  return request('/api/lists', {
    method: 'POST',
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/lists', () => {
  it('🔴 未ログインでは作れない', async () => {
    const res = await request('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(401)
    expect(await testDb().select().from(lists)).toEqual([])
  })

  it('タイトルを省略すると既定のタイトルになる', async () => {
    const me = await signIn('creator@example.com')

    const res = await createList(me.headers)

    expect(res.status).toBe(201)

    const [row] = await testDb().select().from(lists)
    expect(row?.title).toBe(DEFAULT_LIST_TITLE)
  })

  it('タイトルを指定できる。公開範囲の既定は非公開', async () => {
    const me = await signIn('creator2@example.com')

    await createList(me.headers, { title: '2026年の目標' })

    const [row] = await testDb().select().from(lists)
    expect(row?.title).toBe('2026年の目標')
    // 公開は明示的な操作でのみ起きる（PRODUCT_SPEC.md §5.1）
    expect(row?.visibility).toBe('private')
  })

  it('作った本人のものになる', async () => {
    const me = await signIn('owner@example.com')

    const res = await createList(me.headers)
    const { list } = await res.json<{ list: { id: string; userId: string } }>()

    expect(list.userId).toBe(me.userId)
  })

  it('🔴 ID が連番ではない（推測できない）', async () => {
    const me = await signIn('ids@example.com')

    const first = await (await createList(me.headers)).json<{ list: { id: string } }>()
    const second = await (await createList(me.headers)).json<{ list: { id: string } }>()

    expect(first.list.id).not.toBe(second.list.id)
    // 連番だと他人のリストの存在と件数が URL から分かる（CLAUDE.md の不変条件）
    expect(first.list.id).not.toMatch(/^\d+$/)
    expect(first.list.id.length).toBeGreaterThan(16)
  })

  describe('1人あたりの上限', () => {
    it('🔴 上限を超えて作れない', async () => {
      const me = await signIn('many@example.com')

      for (let i = 0; i < LISTS_PER_USER_MAX; i++) {
        expect((await createList(me.headers)).status).toBe(201)
      }

      const over = await createList(me.headers)

      expect(over.status).toBe(409)
      expect(await over.json()).toEqual({ error: 'List Limit Reached' })
      expect(await testDb().select().from(lists)).toHaveLength(LISTS_PER_USER_MAX)
    })

    it('🔴 他人のリストを自分の件数に入れない', async () => {
      const other = await signIn('other@example.com')
      const db = testDb()

      await db.insert(lists).values(
        Array.from({ length: LISTS_PER_USER_MAX }, (_, i) => ({
          id: `other-${String(i)}`,
          userId: other.userId,
          title: 'x',
        })),
      )

      const me = await signIn('me@example.com')

      // 他人が上限まで持っていても、自分は作れる
      expect((await createList(me.headers)).status).toBe(201)
      expect(await db.select().from(lists).where(eq(lists.userId, me.userId))).toHaveLength(1)
    })

    it('1つ消せばまた作れる', async () => {
      const me = await signIn('recycle@example.com')
      const db = testDb()

      for (let i = 0; i < LISTS_PER_USER_MAX; i++) await createList(me.headers)

      const [first] = await db.select().from(lists).limit(1)
      await db.delete(lists).where(eq(lists.id, first?.id ?? ''))

      expect((await createList(me.headers)).status).toBe(201)
    })
  })

  describe('入力の検証', () => {
    it('上限を超えるタイトルは拒否する', async () => {
      const me = await signIn('long@example.com')

      const res = await createList(me.headers, { title: 'あ'.repeat(LIST_TITLE_MAX_LENGTH + 1) })

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('空のタイトルは拒否する（省略とは違う）', async () => {
      const me = await signIn('empty@example.com')

      const res = await createList(me.headers, { title: '   ' })

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('🔴 知らないキーは拒否する', async () => {
      const me = await signIn('extra@example.com')

      // userId を送って他人のものとして作る、といった経路を塞ぐ
      const res = await createList(me.headers, { userId: 'someone-else', title: 'x' })

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })

    it('🔴 公開範囲を指定して作れない（公開は明示的な操作でのみ）', async () => {
      const me = await signIn('visible@example.com')

      const res = await createList(me.headers, { visibility: 'public' })

      expect(res.status).toBe(400)
      expect(await testDb().select().from(lists)).toEqual([])
    })
  })
})
