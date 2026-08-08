import { createMiddleware } from 'hono/factory'

import type { AppEnv } from './env'

/**
 * 作成系のレート制限。**`requireUser` の後に置く。**
 *
 * 🔴 **キーは利用者ごと。** 一律のキーにすると、誰か1人が走らせただけで
 * **全員が止まる。** IP にしないのは、同じ回線の複数人が巻き添えになるため
 * （ログイン必須の経路なので `userId` が必ずある）。
 *
 * 設定（回数と期間）は `wrangler.jsonc` の `ratelimits`。
 * ⚠️ **計測期間は 10 秒か 60 秒しか選べない。**
 * 日次の上限が要るようになったら D1 のカウンタを併用する（`MEMO.md` §4-4）。
 *
 * 制限に当たったら 429。**理由の分かる応答**にする（黙って失敗させない）。
 */
export const rateLimitCreates = createMiddleware<AppEnv>(async (c, next) => {
  const { success } = await c.env.CREATE_RATE_LIMIT.limit({ key: c.get('userId') })

  if (!success) {
    return c.json({ error: 'Too Many Requests' } as const, 429)
  }

  return next()
})

/**
 * 画像出力のレート制限。**`requireUser` の後に置く。**
 *
 * 🔴 **作成系と別の枠にする。** 1回で 100 項目をラスタライズするので、
 * 他の操作とは重さが桁違い（生成サービスの CPU 枠を溶かす。`TECH_STACK.md` §9）。
 * 同じ枠にすると、**画像を連打した人が項目の編集まで止めてしまう。**
 *
 * 設定（回数と期間）は `wrangler.jsonc` の `ratelimits`。
 */
export const rateLimitImages = createMiddleware<AppEnv>(async (c, next) => {
  const { success } = await c.env.IMAGE_RATE_LIMIT.limit({ key: c.get('userId') })

  if (!success) {
    return c.json({ error: 'Too Many Requests' } as const, 429)
  }

  return next()
})
