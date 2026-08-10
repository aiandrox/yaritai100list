import { exports } from 'cloudflare:workers'
import { DISCOVER_MAX_PAGE, DISCOVER_PAGE_SIZE } from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { createTestUser, testBaseUrl, testDb } from './helpers'

/**
 * 取り入れ面のプールのテスト（#233 / 親 #10）。
 *
 * 🔴 見るのは3つ。
 *
 * - **出てはいけない本文が出ないこと**（認可。`docs/workflow.md` §6）。
 *   リンク限定公開の項目がプールに流れると「URL を知っている人だけ」という約束が破れる
 * - **人数を応答に入れていないこと。** 人数は非公開リストも数えているので、
 *   出すと**何人が非公開でその本文を持っているかを問い合わせられる**
 * - **並び順が毎回同じこと。** 同数のときに揺れると画面が意味もなく並び替わる
 */

const discover = (query = '') =>
  exports.default.fetch(new Request(`${testBaseUrl()}/api/discover${query}`))

async function readPool(query = '') {
  const res = await discover(query)
  const body = await res.json<{ items: { text: string }[]; hasNext: boolean }>()

  return { status: res.status, items: body.items, hasNext: body.hasNext }
}

const texts = (rows: { text: string }[]) => rows.map((row) => row.text)

/**
 * 公開範囲を指定してリストを作り、項目を入れる。
 *
 * **持ち主を分けられるようにしてある**（人数で並べるため）。
 */
async function makeList(options: {
  id: string
  visibility: 'private' | 'unlisted' | 'public'
  texts: string[]
  userId?: string
}) {
  const db = testDb()
  const userId = options.userId ?? (await createTestUser(`${options.id}@example.com`))

  await db.insert(lists).values({
    id: options.id,
    userId,
    title: 'x',
    visibility: options.visibility,
    shareId: crypto.randomUUID().replaceAll('-', ''),
  })

  const rows = options.texts.map((text, position) => ({
    id: `${options.id}-${String(position)}`,
    listId: options.id,
    text,
    position,
  }))

  // ⚠️ **1文にまとめない。** D1 はバインド変数の数に上限があり、
  // 100件を1文で入れると `too many SQL variables` で落ちる（#89 で踏んだのと同じ）
  for (let i = 0; i < rows.length; i += 20) {
    await db.insert(items).values(rows.slice(i, i + 20))
  }

  return { userId }
}

describe('GET /api/discover', () => {
  it('未ログインでも読める（書き始める前の人が対象）', async () => {
    await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })

    const pool = await readPool()

    expect(pool.status).toBe(200)
    expect(texts(pool.items)).toEqual(['南極に行く'])
  })

  it('1件も公開リストが無くても落ちない', async () => {
    expect((await readPool()).items).toEqual([])
  })

  describe('出してよい本文', () => {
    it('🔴 リンク限定公開のリストにしか無い本文は出ない', async () => {
      // ここが漏れると「URL を知っている人だけ」という約束が破れる
      await makeList({ id: 'u1', visibility: 'unlisted', texts: ['リンク限定の項目'] })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 非公開リストにしか無い本文は出ない', async () => {
      await makeList({ id: 's1', visibility: 'private', texts: ['非公開の項目'] })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 全公開を解除すると本文がプールから消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      expect(texts((await readPool()).items)).toEqual(['南極に行く'])

      await testDb().update(lists).set({ visibility: 'private' })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 本文を書き換えると、古い本文がプールから消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['書き換える前'] })

      await testDb().update(items).set({ text: '書き換えた後' })

      expect(texts((await readPool()).items)).toEqual(['書き換えた後'])
    })

    it('他の人が全公開で書いていれば残る', async () => {
      // 「そのテキストを持つ全公開リストが無くなったら消える」の裏側
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['南極に行く'] })

      await testDb().update(lists).set({ visibility: 'private' }).where(eq(lists.id, 'p1'))

      expect(texts((await readPool()).items)).toEqual(['南極に行く'])
    })
  })

  describe('返す内容', () => {
    it('🔴 本文だけを返す（人数も作者も完了状態も返さない）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await testDb().update(items).set({ completedAt: new Date() })

      const [row] = (await readPool()).items

      expect(row).toEqual({ text: '南極に行く' })
    })

    it('🔴 人数を返さない（非公開リストの中身が集計から探れないように）', async () => {
      // 出すと「知りたい本文を自分の全公開リストに書く → 人数を読む」で、
      // 何人が非公開でそれを持っているかを問い合わせられる
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await makeList({ id: 's1', visibility: 'private', texts: ['南極に行く'] })

      const [row] = (await readPool()).items

      expect(Object.keys(row ?? {})).toEqual(['text'])
    })
  })

  describe('本文でまとめる', () => {
    it('同じ本文が2つの公開リストにあっても1行になる', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く', 'A'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['南極に行く', 'B'] })

      expect((await readPool()).items.filter((row) => row.text === '南極に行く')).toHaveLength(1)
    })
  })

  describe('並び順', () => {
    it('書いている人が多い順', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['ひとり', 'みんな'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['みんな'] })

      expect(texts((await readPool()).items)).toEqual(['みんな', 'ひとり'])
    })

    it('🔴 非公開リストの人も数に入る', async () => {
      // 公開リストが少ないうちは全部1人になり、順序が付かない
      await makeList({ id: 'p1', visibility: 'public', texts: ['ひとり', 'かくれて人気'] })
      await makeList({ id: 's1', visibility: 'private', texts: ['かくれて人気'] })
      await makeList({ id: 'u1', visibility: 'unlisted', texts: ['かくれて人気'] })

      expect(texts((await readPool()).items)).toEqual(['かくれて人気', 'ひとり'])
    })

    it('🔴 同じ人が何度書いても1人（リストを増やして上位に来られない）', async () => {
      const { userId } = await makeList({
        id: 'p1',
        visibility: 'public',
        texts: ['ひとりで連投', 'ふたり'],
      })
      await makeList({ id: 'p2', visibility: 'public', texts: ['ひとりで連投'], userId })
      await makeList({ id: 'p3', visibility: 'public', texts: ['ひとりで連投'], userId })
      await makeList({ id: 'p4', visibility: 'public', texts: ['ふたり'] })

      expect(texts((await readPool()).items)).toEqual(['ふたり', 'ひとりで連投'])
    })

    it('🔴 人数が並んだら本文順（応答が毎回同じ）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['C', 'A', 'B'] })

      expect(texts((await readPool()).items)).toEqual(['A', 'B', 'C'])
      expect(texts((await readPool()).items)).toEqual(['A', 'B', 'C'])
    })
  })

  describe('ページ送り（#246）', () => {
    /** 1ページに収まらない数を、本文順が分かる形で用意する。 */
    const overflow = () =>
      Array.from({ length: DISCOVER_PAGE_SIZE + 5 }, (_, i) => String(i).padStart(4, '0'))

    it('1ページに出す数に上限がある', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: overflow() })

      expect((await readPool()).items).toHaveLength(DISCOVER_PAGE_SIZE)
    })

    it('🔴 1ページ目で「次がある」と分かる', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: overflow() })

      expect((await readPool()).hasNext).toBe(true)
    })

    it('🔴 収まりきるときは「次がある」と言わない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B'] })

      expect((await readPool()).hasNext).toBe(false)
    })

    it('2ページ目に続きが出る（1ページ目と重ならない）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: overflow() })

      const first = await readPool()
      const second = await readPool('?page=2')

      expect(second.items).toHaveLength(5)
      expect(second.hasNext).toBe(false)
      // ちょうど境目で1件飛ぶ／重なる、が一番ありがちな間違い
      expect(texts(second.items)[0]).toBe(String(DISCOVER_PAGE_SIZE).padStart(4, '0'))
      expect(texts(first.items)).not.toContain(texts(second.items)[0])
    })

    it('中身が無いページは空になる（落ちない）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A'] })

      expect((await readPool('?page=3')).items).toEqual([])
    })

    describe('断るもの', () => {
      it('🔴 ページ数に上限がある（飛ばす件数を大きくさせない）', async () => {
        // 大きい offset はプール全体を走査したうえで0件を返す
        expect((await discover(`?page=${String(DISCOVER_MAX_PAGE + 1)}`)).status).toBe(400)
      })

      it('0 以下のページを断る', async () => {
        expect((await discover('?page=0')).status).toBe(400)
        expect((await discover('?page=-1')).status).toBe(400)
      })

      it('数でないページを断る', async () => {
        expect((await discover('?page=abc')).status).toBe(400)
      })

      it('小数を断る', async () => {
        expect((await discover('?page=1.5')).status).toBe(400)
      })
    })
  })
})
