import { exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists, users, wishTexts } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'
import { makeList, runBatch } from './pool-helpers'

/**
 * アカウントの削除（#308）。**取り消せない操作なので、消える範囲を固定する。**
 *
 * 🔴 見るのは3つ。
 *
 * - **他人を消せないこと**（`userId` を受け取る口が無い）
 * - **消し残らないこと。** cascade で消えないものが2つある（`pool` と `wish_texts`）
 * - **消しすぎないこと。** 同じ本文を書いている別の人のものは残る
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

const deleteAccount = (headers?: Headers) =>
  request('/api/account', {
    method: 'DELETE',
    ...(headers === undefined ? {} : { headers: Object.fromEntries(headers) }),
  })

const readPool = async () => {
  const res = await request('/api/discover')
  const body = await res.json<{ items: { text: string }[] }>()

  return body.items.map((item) => item.text)
}

describe('DELETE /api/account', () => {
  it('🔴 未ログインでは消せない', async () => {
    expect((await deleteAccount()).status).toBe(401)
  })

  /**
   * 🔴 **`userId` を受け取る口が無い**ので、他人を指定する方法が無い。
   * ここで見ているのは「**指定しても自分が消えるだけ**」という形。
   */
  it('🔴 他人のアカウントは消せない（指定する口が無い）', async () => {
    const me = await signIn('me@example.com')
    const other = await signIn('other@example.com')

    // 本文に他人の id を入れても、消えるのは自分だけ
    const res = await request('/api/account', {
      method: 'DELETE',
      headers: { ...Object.fromEntries(me.headers), 'content-type': 'application/json' },
      body: JSON.stringify({ userId: other.userId }),
    })

    expect(res.status).toBe(200)

    const remaining = await testDb().select().from(users)
    expect(remaining.map((row) => row.id)).toEqual([other.userId])
  })

  it('リストと項目も消える（cascade）', async () => {
    const me = await signIn('me@example.com')
    await testDb().insert(lists).values({ id: 'my-list', userId: me.userId, title: 'x' })
    await testDb()
      .insert(items)
      .values({ id: 'i1', listId: 'my-list', text: '南極に行く', position: 0 })

    expect((await deleteAccount(me.headers)).status).toBe(200)

    expect(await testDb().select().from(lists)).toHaveLength(0)
    expect(await testDb().select().from(items)).toHaveLength(0)
  })

  it('🔴 消した後、そのセッションでは何も通らない', async () => {
    const me = await signIn('me@example.com')
    await deleteAccount(me.headers)

    const res = await request('/api/lists', { headers: Object.fromEntries(me.headers) })

    expect(res.status).toBe(401)
  })

  it('共有 URL が開けなくなる', async () => {
    const me = await signIn('me@example.com')
    await testDb().insert(lists).values({
      id: 'my-list',
      userId: me.userId,
      title: 'x',
      shareId: 'sharedsharedshared01',
      visibility: 'unlisted',
    })

    expect((await request('/share/sharedsharedshared01')).status).toBe(200)

    await deleteAccount(me.headers)

    expect((await request('/share/sharedsharedshared01')).status).toBe(404)
  })

  describe('消し残るものを片付ける', () => {
    /**
     * 🔴 **プールはバッチが1時間ごとに作り直す。**
     * 放っておくと「消したのに `/discover` に出ている」が最大1時間続くので、
     * 削除の直後に作り直している。
     */
    it('🔴 さがす画面から消える（最大1時間の残留を作らない）', async () => {
      const me = await signIn('owner@example.com')
      await makeList({
        id: 'mine',
        visibility: 'public',
        texts: ['南極に行く'],
        userId: me.userId,
      })
      await runBatch()

      expect(await readPool()).toContain('南極に行く')

      await deleteAccount(me.headers)

      expect(await readPool()).not.toContain('南極に行く')
    })

    it('🔴 同じ本文を書いている人が残っていれば、さがす画面に残る', async () => {
      const me = await signIn('owner@example.com')
      await makeList({
        id: 'mine',
        visibility: 'public',
        texts: ['南極に行く'],
        userId: me.userId,
      })
      await makeList({ id: 'theirs', visibility: 'public', texts: ['南極に行く'] })
      await runBatch()

      await deleteAccount(me.headers)

      expect(await readPool()).toContain('南極に行く')
    })

    /**
     * 🔴 **判定のキャッシュは「書かれたままの本文」をキーにしていて、誰が書いたかを持たない。**
     * 消さないと、**アカウントを消した人の文章がテーブルに残る。**
     */
    it('🔴 参照されなくなった判定のキャッシュを消す', async () => {
      const me = await signIn('owner@example.com')
      await makeList({
        id: 'mine',
        visibility: 'public',
        texts: ['南極に行く'],
        userId: me.userId,
      })
      await runBatch()

      expect(await testDb().select().from(wishTexts)).not.toHaveLength(0)

      await deleteAccount(me.headers)

      expect(await testDb().select().from(wishTexts)).toHaveLength(0)
    })

    it('🔴 まだ誰かが書いている本文の判定は残す（消しすぎない）', async () => {
      const me = await signIn('owner@example.com')
      await makeList({
        id: 'mine',
        visibility: 'public',
        texts: ['南極に行く'],
        userId: me.userId,
      })
      await makeList({ id: 'theirs', visibility: 'public', texts: ['南極に行く'] })
      await runBatch()

      await deleteAccount(me.headers)

      const remaining = await testDb()
        .select()
        .from(wishTexts)
        .where(eq(wishTexts.rawText, '南極に行く'))

      expect(remaining).toHaveLength(1)
    })
  })
})
