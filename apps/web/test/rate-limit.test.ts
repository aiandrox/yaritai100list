import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 作成系のレート制限のテスト（#92）。
 *
 * 設定（回数と期間）は `wrangler.jsonc` の `ratelimits`。
 * ここで確かめるのは**キーが利用者ごとに分かれていること**と、
 * **当たったら 429 が返ること**。回数そのものは設定値に追随させる。
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

function createList(headers: Headers) {
  return request('/api/lists', {
    method: 'POST',
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: '{}',
  })
}

/** 制限に当たるまで叩く。当たらなければ null。 */
async function untilLimited(headers: Headers, attempts: number): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const res = await createList(headers)
    if (res.status === 429) return i
  }

  return null
}

describe('作成系のレート制限', () => {
  it('🔴 叩き続けると 429 が返る', async () => {
    const me = await signIn('flooder@example.com')

    const limitedAt = await untilLimited(me.headers, 200)

    expect(limitedAt).not.toBeNull()

    // 当たった後の応答は理由が分かる形（黙って失敗させない）
    const res = await createList(me.headers)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Too Many Requests' })
  })

  it('🔴 制限のキーが利用者ごとに分かれている（他人の操作で自分が止まらない）', async () => {
    const flooder = await signIn('other-flooder@example.com')
    await untilLimited(flooder.headers, 200)

    const me = await signIn('victim@example.com')

    // 一律のキーにすると、誰か1人が走らせただけで全員が止まる
    expect((await createList(me.headers)).status).toBe(201)
  })

  it('🔴 制限に当たった要求はリストを作らない', async () => {
    const me = await signIn('nothing-created@example.com')
    await untilLimited(me.headers, 200)

    const before = await testDb().select().from(lists)
    expect((await createList(me.headers)).status).toBe(429)

    expect(await testDb().select().from(lists)).toHaveLength(before.length)
  })

  it('未ログインは 401 のまま（レート制限より先に落ちる）', async () => {
    const res = await request('/api/lists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(res.status).toBe(401)
  })
})
