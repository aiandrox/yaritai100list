import { exports } from 'cloudflare:workers'
import { LEGAL_EFFECTIVE_DATE } from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { users } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 「規約ができた後に登録した人か」の判定（#325）。
 *
 * 🔴 **これで «断ったらアカウントごと捨てる» 相手を決めている。**
 * 間違えると、**前から使っている人のデータを消しかねない。**
 *
 * ⚠️ **境目は日本時間の 0 時**（完了日と同じ扱い）。
 */

const readAccount = (headers: Headers) =>
  exports.default.fetch(
    new Request(`${testBaseUrl()}/api/account`, { headers: Object.fromEntries(headers) }),
  )

/** 規約の制定日（日本時間の 0 時）の前後1秒 */
const TERMS_AT = Date.parse(`${LEGAL_EFFECTIVE_DATE}T00:00:00.000Z`) - 9 * 60 * 60 * 1000

const setCreatedAt = (userId: string, at: number) =>
  testDb()
    .update(users)
    .set({ createdAt: new Date(at) })
    .where(eq(users.id, userId))

describe('joinedAfterTerms', () => {
  it('🔴 規約より後に登録した人は true（断ったら捨てる相手）', async () => {
    const me = await signIn('new@example.com')
    await setCreatedAt(me.userId, TERMS_AT + 1000)

    const body = await (await readAccount(me.headers)).json<{ joinedAfterTerms: boolean }>()

    expect(body.joinedAfterTerms).toBe(true)
  })

  it('🔴 規約より前から居る人は false（消してはいけない）', async () => {
    const me = await signIn('old@example.com')
    await setCreatedAt(me.userId, TERMS_AT - 1000)

    const body = await (await readAccount(me.headers)).json<{ joinedAfterTerms: boolean }>()

    expect(body.joinedAfterTerms).toBe(false)
  })

  it('🔴 ちょうど境目は「後」に入れる（同じ瞬間を両方に入れない）', async () => {
    const me = await signIn('edge@example.com')
    await setCreatedAt(me.userId, TERMS_AT)

    const body = await (await readAccount(me.headers)).json<{ joinedAfterTerms: boolean }>()

    expect(body.joinedAfterTerms).toBe(true)
  })
})
