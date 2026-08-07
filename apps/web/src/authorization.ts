import * as Sentry from '@sentry/cloudflare'
import { and, eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'

import { createAuth } from './auth'
import { createDb } from './db'
import { items, lists } from './db/schema'
import type { AppEnv } from './env'

/**
 * 認可はここに集める。**ハンドラごとに所有者チェックを書かない。**
 *
 * `CLAUDE.md` の不変条件「認可はサーバーのコード1箇所に集める」の実体。
 * 1箇所に集めるだけでなく、**構造的に迂回できない形**にしている:
 *
 * - ハンドラは `listId` を受け取らない。`c.get('list')` で**すでに認可を通った行**を受け取る
 * - つまりミドルウェアを付け忘れたハンドラには、そもそも触れるリストが無い
 *
 * 「チェックを呼び忘れる」ではなく「呼び忘れたら動かない」に寄せている。
 */

/**
 * ログインしていることを要求する。
 *
 * セッションは D1 から引く（Cookie キャッシュは無効。`src/auth.ts`）。
 * つまり**サーバー側で行を消せば、この時点で拒否される。**
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const auth = createAuth(createDb(c.env.DB), c.env)
  const session = await auth.api.getSession({ headers: c.req.raw.headers })

  if (!session) {
    return c.json({ error: 'Unauthorized' } as const, 401)
  }

  c.set('userId', session.user.id)

  // 障害がどの利用者で起きたかを追えるようにする。**id だけ。**
  // メールアドレスや名前は送らない（`src/sentry.ts` の scrubEvent で二重に落としている）
  Sentry.setUser({ id: session.user.id })

  // noImplicitReturns があるので return で揃える
  return next()
})

/**
 * URL の `listId` が**ログイン中の利用者のもの**であることを要求する。
 *
 * 🔴 **見つからない場合と他人のものである場合で、同じ応答を返す。**
 * 404 と 403 を出し分けると「その ID は存在する」ことが分かってしまい、
 * 推測不可能な ID にしている意味が薄れる（`CLAUDE.md` の不変条件）。
 *
 * `requireUser` の後に置く。
 */
export const requireOwnedList = createMiddleware<AppEnv>(async (c, next) => {
  const listId = c.req.param('listId')
  const userId = c.get('userId')

  // このミドルウェアを `:listId` を持たないルートに付けた場合。
  // 型が `string | undefined` になることで気づける。
  // 例外にせず 404 にするのは、他の「見つからない」と応答を揃えるため
  if (listId === undefined) {
    return c.json({ error: 'Not Found' } as const, 404)
  }

  const [list] = await createDb(c.env.DB)
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.userId, userId)))
    .limit(1)

  if (!list) {
    return c.json({ error: 'Not Found' } as const, 404)
  }

  c.set('list', list)

  return next()
})

/**
 * URL の `itemId` が**そのリストの項目**であることを要求する。
 *
 * **`requireOwnedList` の後に置く。** リストの所有者チェックは済んでいる前提で、
 * ここでは「その項目がこのリストのものか」だけを見る。
 *
 * 🔴 **他人のリストの項目 ID を渡されても、応答は「見つからない」で揃える。**
 * `requireOwnedList` が先に 404 を返すので他人のリストには入れないが、
 * **自分のリストの URL に他人の項目 ID を混ぜる**経路がありうる。
 * `list_id` で絞ることで、その項目が存在するかどうかも漏らさない。
 */
export const requireOwnedItem = createMiddleware<AppEnv>(async (c, next) => {
  const itemId = c.req.param('itemId')

  // `:itemId` を持たないルートに付けた場合。他の「見つからない」と応答を揃える
  if (itemId === undefined) {
    return c.json({ error: 'Not Found' } as const, 404)
  }

  const [item] = await createDb(c.env.DB)
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.listId, c.get('list').id)))
    .limit(1)

  if (!item) {
    return c.json({ error: 'Not Found' } as const, 404)
  }

  c.set('item', item)

  return next()
})
