import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { createAuth } from '../src/auth'
import { testAuth, testDb } from './helpers'
import { sessions, users } from '../src/db/schema'

/**
 * Better Auth が **D1 のバインディング経由**で読み書きできることを確認する。
 *
 * ここが #49 の主眼。1.7 の不具合（`pragma_index_list` が D1 の authorizer に
 * 拒否される）は **`wrangler d1 execute` からは再現せず、バインディング経由でしか出ない。**
 * そのため「CLI で通ったから大丈夫」では検証にならない。
 *
 * テストは workerd の中で動き、D1 はインメモリ（`vitest.config.ts`）。
 * つまりこのテストが通ることは、本番と同じ経路で通ることを意味する。
 */
/** `user` テーブルの行。`adapter.create` の型引数に渡す */
interface UserRow {
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: Date
  updatedAt: Date
}

describe('Better Auth と D1', () => {
  it('アダプタ経由で利用者を作って読み戻せる', async () => {
    const ctx = await testAuth().$context

    const created = await ctx.adapter.create<UserRow>({
      model: 'user',
      data: {
        name: '',
        email: 'someone@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    expect(created.id).toBeTruthy()

    const found = await ctx.adapter.findOne<UserRow>({
      model: 'user',
      where: [{ field: 'email', value: 'someone@example.com' }],
    })

    expect(found?.id).toBe(created.id)
  })

  it('セッションを作れて、Drizzle 側からも同じ行が見える', async () => {
    const auth = testAuth()
    const ctx = await auth.$context

    const created = await ctx.adapter.create<UserRow>({
      model: 'user',
      data: {
        name: '',
        email: 'session-owner@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })

    await ctx.internalAdapter.createSession(created.id, undefined)

    // Better Auth が書いた行を、アプリ側の経路（Drizzle）から読めること。
    // 片方だけで読めても意味がないので、両方から見る
    const rows = await testDb().select({ userId: sessions.userId }).from(sessions)

    expect(rows).toEqual([{ userId: created.id }])
  })

  it('利用者を消すとセッションも消える（外部キーの cascade）', async () => {
    const db = testDb()
    const ctx = await testAuth().$context

    const created = await ctx.adapter.create<UserRow>({
      model: 'user',
      data: {
        name: '',
        email: 'cascade@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    await ctx.internalAdapter.createSession(created.id, undefined)

    await db.delete(users)

    expect(await db.select().from(sessions)).toEqual([])
  })
})

describe('セッションを失効させられること', () => {
  it('D1 の行を消すとセッションが見えなくなる', async () => {
    const ctx = await testAuth().$context

    const created = await ctx.adapter.create<UserRow>({
      model: 'user',
      data: {
        name: '',
        email: 'revoke@example.com',
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })
    const s = await ctx.internalAdapter.createSession(created.id, undefined)

    expect(await ctx.internalAdapter.findSession(s.token)).not.toBeNull()

    // サーバー側から失効させる
    await testDb().delete(sessions)

    expect(await ctx.internalAdapter.findSession(s.token)).toBeNull()
  })

  it('Cookie キャッシュが無効になっている', () => {
    // 有効だと、DB を見ずに Cookie だけで認証が通るため
    // 上のテスト（行を消したら見えない）が成り立たなくなる
    expect(testAuth().options.session.cookieCache.enabled).toBe(false)
  })
})

describe('Cookie の方針', () => {
  it('Domain 属性を付けない（host-only）', () => {
    // workers.dev は他人のワーカーとサブドメインを共有する空間なので、
    // Domain 付きの Cookie は他のワーカーにも送られてしまう
    expect(testAuth().options.advanced.crossSubDomainCookies.enabled).toBe(false)
  })

  it('HttpOnly と SameSite=Lax が既定になっている', () => {
    const attrs = testAuth().options.advanced.defaultCookieAttributes

    expect(attrs.httpOnly).toBe(true)
    expect(attrs.sameSite).toBe('lax')
  })
})

describe('Google プロバイダ', () => {
  it('資格情報が揃っていれば有効になる', () => {
    const auth = createAuth(testDb(), {
      BETTER_AUTH_SECRET: 'test-secret-not-used-outside-tests-0123456789',
      BETTER_AUTH_URL: 'https://example.com',
      GOOGLE_CLIENT_ID: 'dummy-client-id',
      GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
    })

    expect(Object.keys(auth.options.socialProviders)).toEqual(['google'])
  })

  it('資格情報が無い環境では有効にしない（アプリは起動する）', () => {
    // ローカルで .dev.vars に入れていない場合。ログイン手段が無くなるだけで
    // /api/health などは動く
    expect(Object.keys(testAuth().options.socialProviders)).toEqual([])
  })
})

describe('GET /api/login/google', () => {
  it('Google の認可 URL へ 302 で送る', async () => {
    const res = await exports.default.fetch(new Request('https://example.com/api/login/google'), {
      redirect: 'manual',
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(
      /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/,
    )
  })

  it('🔴 state と PKCE の Cookie を引き継ぐ', async () => {
    // signInSocial のレスポンスに乗っている Set-Cookie を落とすと、
    // コールバックで state 不一致になりログインできない。
    // URL だけ取り出す実装にしていないことをここで固定する
    const res = await exports.default.fetch(new Request('https://example.com/api/login/google'), {
      redirect: 'manual',
    })

    expect(res.headers.getSetCookie().length).toBeGreaterThan(0)
  })

  it('要求するスコープが最小限（openid / email / profile）', async () => {
    const res = await exports.default.fetch(new Request('https://example.com/api/login/google'), {
      redirect: 'manual',
    })

    const scope = new URL(res.headers.get('location') ?? '').searchParams.get('scope')

    expect(scope?.split(' ').sort()).toEqual(['email', 'openid', 'profile'])
  })
})
