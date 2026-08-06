import * as Sentry from '@sentry/cloudflare'
import { listTitleSchema, visibilitySchema } from '@yaritai100list/shared'
import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { createAuth } from './auth'
import { requireOwnedList, requireUser } from './authorization'
import { createDb } from './db'
import { lists } from './db/schema'
import type { AppEnv } from './env'
import { sentryOptions } from './sentry'

/**
 * リストの更新で受け付ける内容。**上限は packages/shared の Zod スキーマが唯一の情報源。**
 * 画面側でも同じスキーマを使うので、上限がずれない。
 */
const updateListSchema = z
  .object({
    title: listTitleSchema.optional(),
    visibility: visibilitySchema.optional(),
  })
  .strict()

/**
 * ルートはコンストラクタから直接チェーンする。Hono RPC はメソッドチェーンの
 * 戻り値の型からクライアントの型を作るため、`app` を宣言してから別文で
 * `app.get(...)` を呼ぶと型に route の情報が乗らない（#17 で使う）。
 */
const app = new Hono<AppEnv>()
  .get('/api/health', (c) => c.json({ status: 'ok' } as const))

  // D1 への往復が通っているかだけを確認する。行の内容は返さない
  .get('/api/health/db', async (c) => {
    const db = createDb(c.env.DB)
    await db.select({ id: lists.id }).from(lists).limit(1)
    return c.json({ status: 'ok', db: 'ok' } as const)
  })

  /**
   * Google のログインを開始する。**リンクから辿れるようにするための GET。**
   *
   * Better Auth の `/api/auth/sign-in/social` は POST なので、`<a>` から直接叩けない。
   * ここで受けて Google へリダイレクトする。
   *
   * 🔴 **Set-Cookie を引き継ぐこと。** `signInSocial` のレスポンスには
   * OAuth の `state` と PKCE の verifier を入れた Cookie が乗っている。
   * URL だけ取り出してリダイレクトすると、コールバックで state 不一致になる。
   */
  .get('/api/login/google', async (c) => {
    const auth = createAuth(createDb(c.env.DB), c.env)

    const res = await auth.api.signInSocial({
      body: { provider: 'google', callbackURL: '/' },
      asResponse: true,
    })

    const { url } = await res.json<{ url?: string }>()
    if (!url) throw new Error('Google のサインイン URL を取得できなかった')

    const headers = new Headers({ location: url })
    for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie)

    return new Response(null, { status: 302, headers })
  })

  /**
   * 自分のリストの一覧。**他人の行が混ざらないよう `userId` で絞る。**
   */
  .get('/api/lists', requireUser, async (c) => {
    const rows = await createDb(c.env.DB)
      .select()
      .from(lists)
      .where(eq(lists.userId, c.get('userId')))

    return c.json({ lists: rows })
  })

  /**
   * リスト1件。**`requireOwnedList` が認可を通した行を返すだけ。**
   * ハンドラは `listId` を触らないので、認可を迂回する余地が無い。
   */
  .get('/api/lists/:listId', requireUser, requireOwnedList, (c) => c.json({ list: c.get('list') }))

  /** リストのタイトルと公開範囲を変える。 */
  .patch(
    '/api/lists/:listId',
    requireUser,
    requireOwnedList,
    zValidator('json', updateListSchema),
    async (c) => {
      const list = c.get('list')
      const patch = c.req.valid('json')

      const [updated] = await createDb(c.env.DB)
        .update(lists)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(lists.id, list.id))
        .returning()

      return c.json({ list: updated })
    },
  )

  /** リストを削除する。 */
  .delete('/api/lists/:listId', requireUser, requireOwnedList, async (c) => {
    await createDb(c.env.DB)
      .delete(lists)
      .where(eq(lists.id, c.get('list').id))

    return c.json({ deleted: true } as const)
  })

  /**
   * Better Auth の全エンドポイント（セッション取得、コールバック等）。
   *
   * **`wrangler.jsonc` の `run_worker_first` に `/api/*` が入っているので Worker に届く。**
   * ここを `/auth/*` のような別のプレフィックスに変えるなら、あちらにも足すこと。
   * 足し忘れると SPA の index.html が返り、404 にならないので気づきにくい。
   */
  .on(['GET', 'POST'], '/api/auth/*', (c) => {
    const auth = createAuth(createDb(c.env.DB), c.env)
    return auth.handler(c.req.raw)
  })

/**
 * 🔴 **Hono は例外を自前で捕まえて 500 を返すため、`withSentry` には例外が届かない。**
 * ここで明示的に Sentry へ送る。これが無いと、SDK を正しく初期化していても
 * ルート内で起きた例外が1件も通知されない。
 *
 * レスポンスには理由を載せない。例外メッセージに内部の情報が入りうるため。
 */
app.onError((error, c) => {
  Sentry.captureException(error)
  return c.json({ error: 'Internal Server Error' } as const, 500)
})

/**
 * Sentry で包んでからエクスポートする。`onError` を通らない経路
 * （ミドルウェアより手前で起きる例外など）はここで捕まる。
 *
 * `defineCloudflareOptions` + `instrument.server.ts` による自動計装もあるが、
 * **プラグインが暗黙に拾う形は採らない。** どこで初期化されているかがコードから
 * 追えなくなる（`TECH_STACK.md` §1 の「暗黙のルールが少ないか」）。
 *
 * `sentryOptions` は DSN が無ければ `undefined` を返し、SDK は初期化されない。
 */
export default Sentry.withSentry(sentryOptions, app)

/**
 * Hono RPC のクライアント用。包む前の `app` の型を使う。
 * `withSentry` の戻り値は元の型をそのまま返すが、意図を明示するためこちらを参照する。
 */
export type AppType = typeof app
