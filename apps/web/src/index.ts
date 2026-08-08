import * as Sentry from '@sentry/cloudflare'
import {
  buildExportFile,
  DEFAULT_LIST_TITLE,
  EXPORT_VERSION,
  exportFileSchema,
  hasFutureCompletedAt,
  ITEMS_PER_LIST_MAX,
  LISTS_PER_USER_MAX,
  SHARED_VISIBILITIES,
  itemTextSchema,
  signExportImagePayload,
  signOgPayload,
  listTitleSchema,
  visibilitySchema,
} from '@yaritai100list/shared'
import { zValidator } from '@hono/zod-validator'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { createAuth } from './auth'
import { requireOwnedItem, requireOwnedList, requireUser } from './authorization'
import { createDb, type Db } from './db'
import { items, lists } from './db/schema'
import type { AppEnv } from './env'
import { newId, newShareId } from './id'
import { buildExportImagePayload, EXPORT_IMAGE_FILE_NAME, exportImageRequest } from './export-image'
import { buildOgPayload, cacheControlFor, ogImageUrl, renderRequestUrl } from './og'
import { rateLimitCreates, rateLimitImages } from './rate-limit'
import { renderSharePage, renderShareNotFound } from './share'
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

/**
 * localStorage からの取り込みで受け取る内容（`PRODUCT_SPEC.md` §2）。
 *
 * 🔴 **完了の状態を受け取らない。** 未ログインでは「やった」印を付けられないので
 * （#77）、ブラウザ側に完了した項目は存在しない。受け取る口を作ると、
 * **その制約を要求の組み立てだけで迂回できてしまう。**
 *
 * **1項目も無いものは取り込まない**という規則があるので、`min(1)` で弾く。
 * 画面側でも呼ぶ前に判定するが（#91）、規則はサーバーにも置く。
 */
const importListSchema = z
  .object({
    title: listTitleSchema.optional(),
    items: z
      .array(z.object({ text: itemTextSchema }).strict())
      .min(1)
      .max(ITEMS_PER_LIST_MAX),
  })
  .strict()

/**
 * 一度の `insert` に入れる項目の数。
 *
 * ⚠️ **D1 は1文あたりのバインド変数に上限がある**（100件を1文で入れると
 * `too many SQL variables` で落ちる。#89 で踏んだ）。1行4列なので20行ずつに割る。
 * 分けても `batch` に渡せば1トランザクションのまま。
 */
const INSERT_CHUNK = 20

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
  .post(
    '/api/lists',
    requireUser,
    rateLimitCreates,
    zValidator('json', createListSchema),
    async (c) => {
      const db = createDb(c.env.DB)
      const userId = c.get('userId')

      // 推測不可能な ID。連番にしない（CLAUDE.md の不変条件）
      const id = newId()
      const title = c.req.valid('json').title ?? DEFAULT_LIST_TITLE

      const inserted = await db.all<{ id: string }>(sql`
      insert into ${lists} (id, user_id, title, share_id)
      select ${id}, ${userId}, ${title}, ${newShareId()}
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
    },
  )

  /**
   * ブラウザに書いていたリストを取り込む（`PRODUCT_SPEC.md` §2「ログイン時の引き継ぎ」）。
   *
   * 規則をそのまま実装している:
   *
   * - **常に新しいリストとして足す。** すでに持っているリストへのマージはしない
   *   （意図しない混ざりを防ぐ）。1つ目かどうかで挙動を変える必要は無い
   * - **1項目も無いものは取り込まない**（`importListSchema` の `min(1)`）
   * - **上限に達していたら取り込まない。** 409 を返して、
   *   ブラウザ側のデータを消さずに残せるようにする（勝手に捨てない）
   *
   * リストを作れたのに項目が入らない、という中途半端な状態を残さないため、
   * **項目の挿入が失敗したらリストを消してから投げ直す。**
   */
  .post(
    '/api/lists/import',
    requireUser,
    rateLimitCreates,
    zValidator('json', importListSchema),
    async (c) => {
      const db = createDb(c.env.DB)
      const userId = c.get('userId')
      const listId = newId()
      const { title, items: incoming } = c.req.valid('json')

      // 上限の判定と挿入を1文で（POST /api/lists と同じ理由）
      const inserted = await db.all<{ id: string }>(sql`
      insert into ${lists} (id, user_id, title, share_id)
      select ${listId}, ${userId}, ${title ?? DEFAULT_LIST_TITLE}, ${newShareId()}
      where (select count(*) from ${lists} where ${lists.userId} = ${userId}) < ${LISTS_PER_USER_MAX}
      returning id
    `)

      if (inserted.length === 0) {
        return c.json({ error: 'List Limit Reached' } as const, 409)
      }

      const rows = incoming.map((item, position) => ({
        id: newId(),
        listId,
        text: item.text,
        position,
      }))

      const rest = []
      for (let i = INSERT_CHUNK; i < rows.length; i += INSERT_CHUNK) {
        rest.push(db.insert(items).values(rows.slice(i, i + INSERT_CHUNK)))
      }

      try {
        // batch の型は「1つ以上」を要求する。先頭を分けて渡すことで、
        // 空配列になりえないことを型でも示す（項目が1件以上あることは検証済み）
        await db.batch([db.insert(items).values(rows.slice(0, INSERT_CHUNK)), ...rest])
      } catch (error) {
        // 項目の無い空のリストを残さない
        await db.delete(lists).where(eq(lists.id, listId))
        throw error
      }

      const [list] = await db.select().from(lists).where(eq(lists.id, listId))
      if (!list) throw new Error('取り込んだリストを読み戻せなかった')

      return c.json({ list, items: await selectItems(db, listId) }, 201)
    },
  )

  /**
   * 書き出したファイルを読み込む（#122）。**新しいリストとして作る。**
   *
   * 🔴 **`POST /api/lists/import`（localStorage からの引き継ぎ）とは分けてある。**
   * あちらは**完了日時を受け取らない**（未ログインでは印を付けられないという
   * #77 の制約を、受け取る口を作らないことで守っている）。
   * こちらは持ち出しの復元なので完了日時を受け取る。**混ぜると制約が崩れる。**
   *
   * 版が違えば断る。**黙って読める部分だけ読む、ということをしない。**
   */
  .post('/api/lists/restore', requireUser, rateLimitCreates, async (c) => {
    const db = createDb(c.env.DB)
    const userId = c.get('userId')

    // zValidator を通していないのは、**版だけを先に見て理由を返したい**ため。
    // スキーマ全体で弾くと「形が違う」としか言えず、古いファイルだと分からない
    const body: unknown = await c.req.json().catch(() => null)

    const version =
      typeof body === 'object' && body !== null && 'version' in body ? body.version : undefined

    if (version !== EXPORT_VERSION) {
      return c.json({ error: 'Unsupported Export Version' } as const, 400)
    }

    const parsed = exportFileSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Bad Request' } as const, 400)
    }

    // 端末の時計もファイルも信用しない。最低限ここだけは見る
    if (hasFutureCompletedAt(parsed.data, new Date())) {
      return c.json({ error: 'Future Completion Date' } as const, 400)
    }

    const listId = newId()
    const incoming = parsed.data.list

    // 上限の判定と挿入を1文で（POST /api/lists と同じ理由）
    const inserted = await db.all<{ id: string }>(sql`
      insert into ${lists} (id, user_id, title, share_id)
      select ${listId}, ${userId}, ${incoming.title}, ${newShareId()}
      where (select count(*) from ${lists} where ${lists.userId} = ${userId}) < ${LISTS_PER_USER_MAX}
      returning id
    `)

    if (inserted.length === 0) {
      return c.json({ error: 'List Limit Reached' } as const, 409)
    }

    const rows = incoming.items.map((item, position) => ({
      id: newId(),
      listId,
      text: item.text,
      position,
      completedAt: item.completedAt === null ? null : new Date(item.completedAt),
    }))

    // 項目が0件のリストも書き出せるので、ここは空になりうる。
    // batch は空配列を受け付けないため、入れるものがあるときだけ呼ぶ
    if (rows.length > 0) {
      const rest = []
      for (let i = INSERT_CHUNK; i < rows.length; i += INSERT_CHUNK) {
        rest.push(db.insert(items).values(rows.slice(i, i + INSERT_CHUNK)))
      }

      try {
        await db.batch([db.insert(items).values(rows.slice(0, INSERT_CHUNK)), ...rest])
      } catch (error) {
        // 項目の入っていない中途半端なリストを残さない
        await db.delete(lists).where(eq(lists.id, listId))
        throw error
      }
    }

    const [list] = await db.select().from(lists).where(eq(lists.id, listId))
    if (!list) throw new Error('読み込んだリストを読み戻せなかった')

    return c.json({ list, items: await selectItems(db, listId) }, 201)
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

  /**
   * リストを1つ書き出す（#121）。**持ち出すのは自分のリストだけ**
   * （`requireOwnedList` を通っている）。
   *
   * 形は `packages/shared` の `buildExportFile`。**版を持たせてある**ので、
   * 形を変えたら上げること（読み込み側が断れる）。
   *
   * ⚠️ **形式は後から増える。** ブログへの転載用にマークダウンでも書き出す予定がある
   * （#124）。そのときは**このルートの隣に足す**（`/export/markdown` など）。
   * ここで分岐を増やして1本にまとめない。中身の作り方が違いすぎる
   * （あちらは人が読むもので、読み込まない）。
   */
  .get('/api/lists/:listId/export', requireUser, requireOwnedList, async (c) => {
    const list = c.get('list')
    const rows = await selectItems(createDb(c.env.DB), list.id)

    return c.json(buildExportFile({ title: list.title, items: rows }, new Date()))
  })

  /**
   * ダウンロード画像（#192）。**やりたいこと全部を1枚に描く。**
   *
   * 🔴 **`requireOwnedList` を通す。** ハンドラは `listId` を受け取らず、
   * **すでに認可を通った行**を `c.get('list')` で受け取る（`src/authorization.ts`）。
   * 他人の `listId` は「見つからない」と同じ 404 になる。
   *
   * 🔴 **ログインが要る**（#194 で決定）。未ログインだとクライアントが本文を送る形になり、
   * **誰でも叩ける POST でラスタライズが走る。**
   *
   * OGP（`/og/:shareId`）との違いは**運び方だけ。** あちらは GET のクエリ、
   * こちらは POST の本文（100項目は URL に載らない。#189）。
   */
  .get('/api/lists/:listId/image', requireUser, requireOwnedList, rateLimitImages, async (c) => {
    const list = c.get('list')
    const { RENDER_URL, RENDER_HMAC_SECRET } = c.env

    /** 出せないときの返し。**理由は利用者に見せず、ログに残す**（#180 と同じ）。 */
    const unavailable = (reason: string) => {
      console.error(`export: ${reason}`)
      return c.json({ error: 'Image Not Available' } as const, 503)
    }

    // 🔴 **鍵が無ければ画像を出さない。** 署名なしで叩ける状態を作らない
    if (!RENDER_HMAC_SECRET) {
      return unavailable('RENDER_HMAC_SECRET が設定されていない')
    }

    const rows = await selectItems(createDb(c.env.DB), list.id)
    const payload = buildExportImagePayload(list, rows, new Date())
    const signature = await signExportImagePayload(payload, RENDER_HMAC_SECRET)

    // ⚠️ **繋がらないときは fetch が投げる。** 捕まえないと 500 になり、
    // **失敗を「壊れた」として扱ってしまう**
    let rendered: Response
    try {
      rendered = await fetch(exportImageRequest(RENDER_URL, payload, signature))
    } catch {
      return unavailable(`生成サービスに繋がらない（${RENDER_URL}）`)
    }

    if (!rendered.ok) {
      // **403 なら両側の鍵が違う**（生成サービスは理由を返さない）
      return unavailable(`生成サービスが ${String(rendered.status)} を返した`)
    }

    return new Response(rendered.body, {
      headers: {
        'content-type': rendered.headers.get('content-type') ?? 'image/png',
        // ⚠️ **キャッシュさせない。** URL にバージョンが無く、中身は押すたびに変わりうる
        'cache-control': 'no-store',
        // 直接開かれたときの保険。見せる名前はクライアント側で付ける（#193）
        'content-disposition': `attachment; filename="${EXPORT_IMAGE_FILE_NAME}"`,
      },
    })
  })

  /**
   * 共有リンクを作り直す（#136）。**古い URL はこの時点で無効になる。**
   *
   * 「うっかり送った相手に見られ続ける」状態から抜ける手段（`PRODUCT_SPEC.md` §5.1）。
   * 公開範囲は変えない。**止めたいだけなら非公開にする方が早い**が、
   * 「公開は続けたいが、渡した相手には見せたくない」を満たせるのはこちらだけ。
   *
   * `updated_at` も新しくする。リストに対する操作なので、
   * トップで開く「最後に更新したリスト」の対象になってよい。
   */
  .post('/api/lists/:listId/share-id', requireUser, requireOwnedList, async (c) => {
    const [updated] = await createDb(c.env.DB)
      .update(lists)
      .set({ shareId: newShareId(), updatedAt: new Date() })
      .where(eq(lists.id, c.get('list').id))
      .returning()

    return c.json({ list: updated })
  })

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
    rateLimitCreates,
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

      // 🔴 **位置が変わった項目だけ書き直す**（#142）。
      // 全部書くと、隣と入れ替えるだけで100行の書き込みになる。
      // D1 の無料枠は 10万行/日（`TECH_STACK.md` §13）なので、押すたびに全部書くと重い
      const currentPositions = new Map(current.map((item) => [item.id, item.position]))
      const changed = itemIds
        .map((id, position) => ({ id, position }))
        .filter((row) => currentPositions.get(row.id) !== row.position)

      await db.batch([
        // batch は空配列を受け付けないので、必ず1つは入る touchList を先に置く
        touchList(db, listId),
        ...changed.map((row) =>
          db
            .update(items)
            .set({ position: row.position, updatedAt: new Date() })
            .where(eq(items.id, row.id)),
        ),
      ])

      return c.json({ items: await selectItems(db, listId) })
    },
  )

  /**
   * 共有公開ページ（#137）。**ログインは要らない。**
   *
   * 🔴 **`wrangler.jsonc` の `run_worker_first` に `/share/*` を入れてある。**
   * 入れ忘れると Worker に届かず、SPA の index.html が返る
   * （**404 にならないので気づきにくい**）。
   *
   * 🔴 **公開してよい範囲を列挙して絞る**（`SHARED_VISIBILITIES`）。
   * 「非公開以外」で書くと、後から公開範囲を1つ足したときに黙って公開される。
   *
   * 🔴 **非公開のリストと、存在しない ID で同じものを返す。**
   * 出し分けると「その ID は存在するが非公開」と分かってしまう。
   *
   * 渡すのは**タイトルと項目だけ。** 作者は渡さない（`PRODUCT_SPEC.md` §5.1）。
   */
  .get('/share/:shareId', async (c) => {
    const db = createDb(c.env.DB)

    const [list] = await db
      .select()
      .from(lists)
      .where(
        and(
          eq(lists.shareId, c.req.param('shareId')),
          inArray(lists.visibility, [...SHARED_VISIBILITIES]),
        ),
      )
      .limit(1)

    if (!list) {
      return c.html(renderShareNotFound(), 404)
    }

    const rows = await selectItems(db, list.id)

    return c.html(
      renderSharePage({
        title: list.title,
        // 🔴 **更新日時を URL に入れる**（#173）。入れないと SNS が古い画像を出し続ける
        imageUrl: ogImageUrl(new URL(c.req.url).origin, list.shareId, list.updatedAt),
        items: rows.map((item) => ({
          text: item.text,
          completedAt: item.completedAt === null ? null : item.completedAt.getTime(),
        })),
      }),
    )
  })

  /**
   * OGP 画像（#171）。**ログインは要らない。**
   *
   * 🔴 **`wrangler.jsonc` の `run_worker_first` に `/og/*` を入れてある。**
   * 入れ忘れると Worker に届かず、SPA の index.html が返る（404 にならない）。
   *
   * 🔴 **共有ページ（#137）と同じ判定を通す。** 非公開のリストは画像も出さない。
   * 「画像だけ漏れる」は典型的な事故（`CLAUDE.md` の不変条件）。
   * 存在しない `shareId` と応答を揃えるのも同じ理由。
   *
   * 画像を作るのは Deno Deploy 側（#172）。**ここは認可して、署名して、渡すだけ。**
   */
  .get('/og/:shareId', async (c) => {
    const db = createDb(c.env.DB)

    const [list] = await db
      .select()
      .from(lists)
      .where(
        and(
          eq(lists.shareId, c.req.param('shareId')),
          inArray(lists.visibility, [...SHARED_VISIBILITIES]),
        ),
      )
      .limit(1)

    if (!list) {
      return c.json({ error: 'Not Found' } as const, 404)
    }

    const { RENDER_URL, RENDER_HMAC_SECRET } = c.env

    /**
     * 画像を出せないときの返し。**理由は利用者に見せず、ログに残す。**
     *
     * ⚠️ **見分けが付かないと直せない**（#174）。
     * 「生成サービスが落ちている」も「両側の鍵が違う」も同じ 503 になるので、
     * 実際に 403 を踏んだとき、**コードを読んでも原因に到達できなかった**。
     *
     * 🔴 **署名も鍵も書かない。** ログに残ると、そこから叩けるようになる
     */
    const unavailable = (reason: string) => {
      console.error(`og: ${reason}`)
      return c.json({ error: 'Image Not Available' } as const, 503)
    }

    // 🔴 **鍵が無ければ画像を出さない。** 署名なしで叩ける状態を作らない
    // （`TECH_STACK.md` §9）。**落ちるのではなく「用意できていない」と返す**。
    // URL の方は wrangler.jsonc の vars にあるので必ずある（消せば型エラーになる）
    if (!RENDER_HMAC_SECRET) {
      return unavailable('RENDER_HMAC_SECRET が設定されていない')
    }

    const payload = buildOgPayload(list, await selectItems(db, list.id), new Date())
    const signature = await signOgPayload(payload, RENDER_HMAC_SECRET)

    // ⚠️ **繋がらないときは fetch が投げる**（サービスがまだ無い、落ちている）。
    // 捕まえないと 500 になり、**失敗を「壊れた」として扱ってしまう**
    let rendered: Response
    try {
      rendered = await fetch(renderRequestUrl(RENDER_URL, payload, signature))
    } catch {
      return unavailable(`生成サービスに繋がらない（${RENDER_URL}）`)
    }

    if (!rendered.ok) {
      // 生成に失敗したものをキャッシュさせない。
      // **403 なら両側の鍵が違う**（生成サービスは理由を返さない）
      return unavailable(`生成サービスが ${String(rendered.status)} を返した`)
    }

    return new Response(rendered.body, {
      headers: {
        'content-type': rendered.headers.get('content-type') ?? 'image/png',
        'cache-control': cacheControlFor(c.req.query('v')),
      },
    })
  })

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
