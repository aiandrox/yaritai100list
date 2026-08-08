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
 *
 * ⚠️ **テストが使う枠は本番より小さい**（`vitest.config.ts` の `ratelimits`。#215）。
 * 制限に当たることを確かめるには枠の数だけ往復するしかなく、
 * 本番の 60 回のままでは CI で5秒を超えて落ちていた。
 * **このファイルに回数を書かない**のは、どちらの値を変えても追随させるため。
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

/**
 * 叩くのを諦める回数。**枠より十分大きく、しかし小さく。**
 *
 * 制限が壊れていたら、ここまで叩いて null を返す（テストは失敗する）。
 * **大きくすると、壊れたときに遅く落ちる。**
 */
const GIVE_UP_AT = 30

/** 制限に当たるまで叩く。当たらなければ null。 */
async function untilLimited(headers: Headers): Promise<number | null> {
  for (let i = 0; i < GIVE_UP_AT; i++) {
    const res = await createList(headers)
    if (res.status === 429) return i
  }

  return null
}

describe('作成系のレート制限', () => {
  it('🔴 叩き続けると 429 が返る', async () => {
    const me = await signIn('flooder@example.com')

    const limitedAt = await untilLimited(me.headers)

    expect(limitedAt).not.toBeNull()

    // 当たった後の応答は理由が分かる形（黙って失敗させない）
    const res = await createList(me.headers)
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Too Many Requests' })
  })

  it('🔴 制限のキーが利用者ごとに分かれている（他人の操作で自分が止まらない）', async () => {
    const flooder = await signIn('other-flooder@example.com')
    await untilLimited(flooder.headers)

    const me = await signIn('victim@example.com')

    // 一律のキーにすると、誰か1人が走らせただけで全員が止まる
    expect((await createList(me.headers)).status).toBe(201)
  })

  it('🔴 制限に当たった要求はリストを作らない', async () => {
    const me = await signIn('nothing-created@example.com')
    await untilLimited(me.headers)

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
