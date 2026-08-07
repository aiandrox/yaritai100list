import * as Sentry from '@sentry/cloudflare'
import {
  DEFAULT_LIST_TITLE,
  ITEMS_PER_LIST_MAX,
  LISTS_PER_USER_MAX,
  itemTextSchema,
  listTitleSchema,
  visibilitySchema,
} from '@yaritai100list/shared'
import { zValidator } from '@hono/zod-validator'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { createAuth } from './auth'
import { requireOwnedItem, requireOwnedList, requireUser } from './authorization'
import { createDb, type Db } from './db'
import { items, lists } from './db/schema'
import type { AppEnv } from './env'
import { newId } from './id'
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
 * リストの作成で受け付ける内容。
 *
 * タイトルは省略できる（既定は `DEFAULT_LIST_TITLE`）。
 * ⚠️ **本文が空の POST は 400 になる。** `zValidator('json', ...)` は本文を要求するので、
 * 何も指定しない場合でも `{}` を送ること（Better Auth の 415 と同じ性質の落とし穴）。
 */
const createListSchema = z.object({ title: listTitleSchema.optional() }).strict()

/** 項目の作成。本文だけ受け取る。**並び順は末尾で、クライアントには決めさせない。** */
const createItemSchema = z.object({ text: itemTextSchema }).strict()

/**
 * 項目の変更。
 *
 * 🔴 **完了「日時」を受け取らない。** `completed` の真偽値だけを受け取り、
 * **日時はサーバーが決める。** 端末の時計は狂っていることがあり、
 * 送られた値をそのまま入れると「未来に叶えたこと」になる。
 *
 * 空の本文（`{}`）は拒否する。黙って何もしない応答を返すと、
 * 送り側の間違いに気づけない。
 */
const updateItemSchema = z
  .object({
    text: itemTextSchema.optional(),
    completed: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: '変更する項目がない' })

/**
 * 並び替え。**そのリストの項目 ID を全部、新しい順で受け取る。**
 *
 * 差分（「この項目を3番目へ」）ではなく全体を受け取るのは、
 * 送り側と DB のずれをここで検出できるようにするため
 * （`TECH_STACK.md` §7 のとおり、並び替えは全件書き直し）。
 */
const reorderItemsSchema = z
  .object({ itemIds: z.array(z.string()).max(ITEMS_PER_LIST_MAX) })
  .strict()

/** そのリストの項目を並び順で取る。 */
function selectItems(db: Db, listId: string) {
  return db.select().from(items).where(eq(items.listId, listId)).orderBy(asc(items.position))
}

/**
 * リストの `updated_at` を今にする。
 *
 * トップを開いたときに**最後に更新したリスト**を出すため（`PRODUCT_SPEC.md` §4.3）、
 * **項目を変えたときもリスト側を触る。** 触らないと、項目だけ書き換えたリストが
 * 「古いリスト」のままになる。
 */
function touchList(db: Db, listId: string) {
  return db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId))
}

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
   * リストを作る。
   *
   * 🔴 **件数の判定と挿入を1文で行う。**
   * 「数えてから入れる」と、素早く2回押されたときに**両方が上限内だと判断して
   * 上限を超える。** `where (select count(*) ...) < 上限` を付けた insert なら、
   * 入らなかったことが「0行返る」で分かる。
   *
   * 上限の値は `packages/shared` から取る。SQL に数字を書かない
   * （`CLAUDE.md` の不変条件）。DB の制約としての上限は #6 で足す。
   */
  .post('/api/lists', requireUser, zValidator('json', createListSchema), async (c) => {
    const db = createDb(c.env.DB)
    const userId = c.get('userId')

    // 推測不可能な ID。連番にしない（CLAUDE.md の不変条件）
    const id = newId()
    const title = c.req.valid('json').title ?? DEFAULT_LIST_TITLE

    const inserted = await db.all<{ id: string }>(sql`
      insert into ${lists} (id, user_id, title)
      select ${id}, ${userId}, ${title}
      where (select count(*) from ${lists} where ${lists.userId} = ${userId}) < ${LISTS_PER_USER_MAX}
      returning id
    `)

    // 0行 = 上限に達していた。**404 と同じ応答にしない**（理由が分からないと直せない）
    if (inserted.length === 0) {
      return c.json({ error: 'List Limit Reached' } as const, 409)
    }

    const [list] = await db.select().from(lists).where(eq(lists.id, id))
    if (!list) throw new Error('作ったリストを読み戻せなかった')

    return c.json({ list }, 201)
  })

  /**
   * リスト1件と、その項目。**`requireOwnedList` が認可を通した行だけを使う。**
   * ハンドラは `listId` を触らないので、認可を迂回する余地が無い。
   *
   * 項目を別の要求に分けていないのは、**画面が必ず両方を要るため**
   * （1リストを開くのが基本の画面。`PRODUCT_SPEC.md` §4.3）。
   */
  .get('/api/lists/:listId', requireUser, requireOwnedList, async (c) => {
    const list = c.get('list')

    return c.json({ list, items: await selectItems(createDb(c.env.DB), list.id) })
  })

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
   * 項目を末尾に足す。
   *
   * 🔴 **件数の判定・並び順の決定・挿入を1文で行う**（リストの作成と同じ理由）。
   * 数えてから入れると、素早く2回押されたときに**上限を超える**し、
   * **同じ並び順の項目が2つできる。**
   */
  .post(
    '/api/lists/:listId/items',
    requireUser,
    requireOwnedList,
    zValidator('json', createItemSchema),
    async (c) => {
      const db = createDb(c.env.DB)
      const listId = c.get('list').id
      const id = newId()
      const { text } = c.req.valid('json')

      const inserted = await db.all<{ id: string }>(sql`
        insert into ${items} (id, list_id, text, position)
        select ${id}, ${listId}, ${text},
               (select count(*) from ${items} where ${items.listId} = ${listId})
        where (select count(*) from ${items} where ${items.listId} = ${listId}) < ${ITEMS_PER_LIST_MAX}
        returning id
      `)

      if (inserted.length === 0) {
        return c.json({ error: 'Item Limit Reached' } as const, 409)
      }

      await touchList(db, listId)

      const [item] = await db.select().from(items).where(eq(items.id, id))
      if (!item) throw new Error('作った項目を読み戻せなかった')

      return c.json({ item }, 201)
    },
  )

  /**
   * 項目の本文と完了を変える。
   *
   * **完了日時はサーバーが決める**（`updateItemSchema` の注意書き）。
   * 完了しても並び順は動かさない（`PRODUCT_SPEC.md` §4.5）。
   */
  .patch(
    '/api/lists/:listId/items/:itemId',
    requireUser,
    requireOwnedList,
    requireOwnedItem,
    zValidator('json', updateItemSchema),
    async (c) => {
      const db = createDb(c.env.DB)
      const item = c.get('item')
      const patch = c.req.valid('json')

      const [updated] = await db
        .update(items)
        .set({
          ...(patch.text === undefined ? {} : { text: patch.text }),
          ...(patch.completed === undefined
            ? {}
            : { completedAt: patch.completed ? new Date() : null }),
          updatedAt: new Date(),
        })
        .where(eq(items.id, item.id))
        .returning()

      await touchList(db, item.listId)

      return c.json({ item: updated })
    },
  )

  /**
   * 項目を消す。
   *
   * **消したら後ろの並び順を詰める。** 詰めないと `position` に穴が空き、
   * 「0から始まる詰まった連番」という前提が崩れる（`TECH_STACK.md` §7）。
   * 削除と詰め直しは `batch` で1トランザクションにする。
   */
  .delete(
    '/api/lists/:listId/items/:itemId',
    requireUser,
    requireOwnedList,
    requireOwnedItem,
    async (c) => {
      const db = createDb(c.env.DB)
      const item = c.get('item')

      await db.batch([
        db.delete(items).where(eq(items.id, item.id)),
        db
          .update(items)
          .set({ position: sql`${items.position} - 1` })
          .where(and(eq(items.listId, item.listId), gt(items.position, item.position))),
        touchList(db, item.listId),
      ])

      return c.json({ deleted: true } as const)
    },
  )

  /**
   * 並び替え。**そのリストの項目 ID を全部、新しい順で受け取って全件書き直す。**
   *
   * 🔴 **送られた ID の集合が、いまの項目とぴったり一致することを確かめる。**
   * 一致を見ないと、**他人の項目 ID を混ぜて自分のリストに引き込む**経路や、
   * 抜けた項目の並び順が古いまま残る経路ができる。
   */
  .put(
    '/api/lists/:listId/items/order',
    requireUser,
    requireOwnedList,
    zValidator('json', reorderItemsSchema),
    async (c) => {
      const db = createDb(c.env.DB)
      const listId = c.get('list').id
      const { itemIds } = c.req.valid('json')

      const current = await selectItems(db, listId)
      const currentIds = new Set(current.map((item) => item.id))
      const sameSet =
        itemIds.length === current.length &&
        new Set(itemIds).size === itemIds.length &&
        itemIds.every((id) => currentIds.has(id))

      if (!sameSet) {
        return c.json({ error: 'Item Set Mismatch' } as const, 409)
      }

      await db.batch([
        // batch は空配列を受け付けないので、必ず1つは入る touchList を先に置く
        touchList(db, listId),
        ...itemIds.map((id, position) =>
          db.update(items).set({ position, updatedAt: new Date() }).where(eq(items.id, id)),
        ),
      ])

      return c.json({ items: await selectItems(db, listId) })
    },
  )

  /**
   * Better Auth の全エンドポイント（セッション取得、サインアウト、コールバック等）。
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
