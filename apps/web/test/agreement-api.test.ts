import { exports } from 'cloudflare:workers'
import { LEGAL_EFFECTIVE_DATE } from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { agreements } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 規約への同意（#319）。
 *
 * 🔴 見るのは3つ。
 *
 * - **記録が無ければ「要る」と返すこと**（これが確認画面を出す条件）
 * - **同意した版をサーバーが決めること**（画面から受け取ると、古い版に同意したことにできる）
 * - **アカウントを消したら記録も消えること**（本人に紐づく情報。#308 と同じ扱い）
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

const readAgreement = (headers?: Headers) =>
  request(
    '/api/account',
    headers === undefined ? undefined : { headers: Object.fromEntries(headers) },
  )

const agree = (headers: Headers) =>
  request('/api/account/agree', { method: 'POST', headers: Object.fromEntries(headers) })

const rowsOf = (userId: string) =>
  testDb().select().from(agreements).where(eq(agreements.userId, userId))

describe('GET /api/account', () => {
  it('🔴 未ログインでは聞けない', async () => {
    expect((await readAgreement()).status).toBe(401)
  })

  /**
   * 🔴 **既存の利用者にも出す**（2026-09-01 の利用者の判断）。
   * マイグレーションで同意済みの行を入れていないので、**記録が無い人は全員ここを通る。**
   */
  it('🔴 記録が無ければ「同意が要る」と返す', async () => {
    const me = await signIn('me@example.com')

    const body = await (await readAgreement(me.headers)).json<{ agreed: boolean }>()

    expect(body.agreed).toBe(false)
  })

  it('同意したあとは「済んでいる」と返す', async () => {
    const me = await signIn('me@example.com')
    await agree(me.headers)

    const body = await (await readAgreement(me.headers)).json<{ agreed: boolean }>()

    expect(body.agreed).toBe(true)
  })

  /**
   * 🔴 **版が変わったら、また聞く。**
   * 規約を改定して `LEGAL_EFFECTIVE_DATE` を動かしたときに、全員がもう一度通る仕組み。
   */
  it('🔴 別の版にしか同意していなければ、また聞く', async () => {
    const me = await signIn('me@example.com')

    await testDb()
      .insert(agreements)
      .values({ id: 'old', userId: me.userId, effectiveOn: '2020-01-01' })

    const body = await (await readAgreement(me.headers)).json<{ agreed: boolean }>()

    expect(body.agreed).toBe(false)
  })
})

describe('POST /api/account/agree', () => {
  it('🔴 未ログインでは記録できない', async () => {
    const res = await request('/api/account/agree', { method: 'POST' })

    expect(res.status).toBe(401)
  })

  it('🔴 いまの版で記録される（版はサーバーが決める）', async () => {
    const me = await signIn('me@example.com')

    expect((await agree(me.headers)).status).toBe(200)

    const rows = await rowsOf(me.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.effectiveOn).toBe(LEGAL_EFFECTIVE_DATE)
  })

  it('🔴 2回押しても1行のまま', async () => {
    const me = await signIn('me@example.com')

    await agree(me.headers)
    await agree(me.headers)

    expect(await rowsOf(me.userId)).toHaveLength(1)
  })

  it('🔴 他人の記録にはならない', async () => {
    const me = await signIn('me@example.com')
    const other = await signIn('other@example.com')

    await agree(me.headers)

    expect(await rowsOf(other.userId)).toHaveLength(0)
  })

  it('🔴 アカウントを消すと同意の記録も消える', async () => {
    const me = await signIn('me@example.com')
    await agree(me.headers)

    await request('/api/account', {
      method: 'DELETE',
      headers: Object.fromEntries(me.headers),
    })

    expect(await testDb().select().from(agreements)).toHaveLength(0)
  })
})
