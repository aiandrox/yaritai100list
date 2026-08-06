import { drizzle } from 'drizzle-orm/d1'

import * as schema from './schema'

/**
 * D1 に触る唯一の入口。
 *
 * ハンドラから `c.env.DB` を直接使わず、必ずここを通す。
 * DB アクセスを1箇所に集めておかないと、認可を通していないクエリが
 * どこかに紛れ込んだときに見つけられない（CLAUDE.md の不変条件）。
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

export type Db = ReturnType<typeof createDb>

export * as schema from './schema'
