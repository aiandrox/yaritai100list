import { env } from 'cloudflare:workers'

import { createDb, type Db } from '../src/db'

/**
 * テスト用の Drizzle クライアント。
 *
 * 本体と同じ `createDb` を通す。テスト専用の接続経路を作ると、
 * 「テストは通るが本番の経路では動かない」状態が起きうる。
 */
export function testDb(): Db {
  return createDb(env.DB)
}

/**
 * すべてのテーブルの行を消す。`test/setup.ts` の `beforeEach` から呼ばれる。
 *
 * テーブル名を列挙せず `sqlite_master` から引くので、**テーブルを増やしても
 * ここを直す必要がない**（消し忘れたテーブルのデータが次のテストに漏れない）。
 *
 * 削除は**作成順の逆**で行う。`sqlite_master` の行は作成順に並んでいるため、
 * 逆順にすると子テーブルが親より先に消える。マイグレーションは親を先に作るのが
 * 普通なので、これで外部キー制約の順序問題をたいてい回避できる。
 * （FK を持つテーブルが増えるのは #3。そこで実際に確認する）
 */
export async function resetDb(): Promise<void> {
  const { results } = await env.DB.prepare(
    `select name from sqlite_master
     where type = 'table'
       and name not like 'sqlite_%'
       and name not like '_cf_%'
       and name != 'd1_migrations'
     order by rowid desc`,
  ).all<{ name: string }>()

  if (results.length === 0) return

  // batch は1トランザクションで実行される
  await env.DB.batch(results.map(({ name }) => env.DB.prepare(`delete from "${name}"`)))
}

/**
 * 認証済みセッションを作るヘルパはここに足す（#3）。
 * 認可のテストを書くときに必要になる。
 */
