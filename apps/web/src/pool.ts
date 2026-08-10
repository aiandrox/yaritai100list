import { POOL_VISIBILITIES } from '@yaritai100list/shared'
import { sql } from 'drizzle-orm'

import type { Db } from './db'
import { pool } from './db/schema'

/**
 * 取り入れ面のプールを作り直す（#254 / 親 #252）。
 *
 * 🔴 **総入れ替えにする。** 差分更新にすると「全公開をやめた本文」「書き換えられた本文」を
 * 消す道を別に用意することになり、消し忘れが**非公開にしたはずの本文の残留**になる。
 * 作り直しなら、その手当てが要らない。
 *
 * 🔴 **集計は SQL だけで完結させる。** 定期実行の CPU は Cloudflare Free で
 * **10ms**（2026-08-10 に確認）。項目を JS に読み込んで数えると、
 * 項目が増えたある日を境に**静かに打ち切られる**。
 * ここが SQL 1文で済むのは `wish_texts` のキーが「書かれたままの本文」だから（#253）。
 */

/**
 * 全公開の公開範囲を SQL に直接書いた形。
 *
 * ⚠️ **バインド変数にしない。** drizzle の `db.batch()` は
 * **バインド変数を持つ生 SQL を扱えない**（`db.run(sql)` が返すものに
 * `stmt` が無く、`stmt.bind(...)` で落ちる）。作り直しは1トランザクションでないと
 * **落ちたときにプールが空になる**ので、こちらを譲る。
 *
 * 🔴 **値は `packages/shared` の定数から作る。** 文字列を手で書かない
 * （`lists.ts` の check 制約と同じやり方）。外から来る値は1つも混ぜないので、
 * ここに埋め込んで危険なものは無い。
 */
const publicVisibilities = sql.raw(
  POOL_VISIBILITIES.map((visibility) => `'${visibility}'`).join(', '),
)

/**
 * プールの中身を作る SQL。
 *
 * 🔴 **出す本文と、数える範囲が違う**（2026-08-10 の利用者の判断）。
 *
 * | | 範囲 |
 * |---|---|
 * | プールに**出す**代表表現 | 全公開リストにある本文から来たものだけ（`POOL_VISIBILITIES`） |
 * | 並べるための**人数** | **全リスト。非公開・リンク限定公開も含む** |
 *
 * 数える範囲を全公開だけにすると、**公開リストが少ないうちは全部1人**で順序が付かない。
 * 非公開まで含めると初日から意味のある順になる。
 * ⚠️ **だから `writers` を応答に入れない**（`db/schema/pool.ts` の注意書き）。
 *
 * ⚠️ **ジャンルは `min()` で1つに決めている。** 同じ代表表現に別のジャンルが
 * 付くことがある（AI が本文ごとに答えるため）。多数決にすると SQL が一段深くなるわりに、
 * **実際にはほぼ揃う。** 揺れるようなら #255 で作り直す。
 * 大事なのは**毎回同じものを選ぶこと**で、`min()` はそれを満たす。
 */
const insertPool = sql`
  insert into pool (canonical, genre, writers)
  select
      judged.canonical,
      min(judged.genre),
      count(distinct owner.user_id)
    from items as written
    join lists as owner on owner.id = written.list_id
    join wish_texts as judged on judged.raw_text = written.text
   where judged.verdict = 'ok'
     and judged.canonical is not null
     and judged.genre is not null
     and judged.canonical in (
           select public_judged.canonical
             from items as public_written
             join lists as public_owner on public_owner.id = public_written.list_id
             join wish_texts as public_judged on public_judged.raw_text = public_written.text
            where public_judged.verdict = 'ok'
              and public_owner.visibility in (${publicVisibilities})
         )
   group by judged.canonical
`

/**
 * プールを総入れ替えする。
 *
 * 🔴 **消すのと入れるのを1トランザクションにする。** `db.batch()` は D1 で
 * 1トランザクションになる。分けて実行すると、間で落ちたときに
 * **次のバッチまでプールが空のまま**になる（取り入れ面が丸ごと消える）。
 *
 * ⚠️ **例外を握りつぶさない。** 呼び出し側（`index.ts` の `runPoolBatch`）が
 * Sentry に送る。ここで黙って戻ると、プールが古いまま何日も気づけない。
 */
export async function rebuildPool(db: Db): Promise<number> {
  await db.batch([db.delete(pool), db.run(insertPool)])

  const [counted] = await db.select({ rows: sql<number>`count(*)` }).from(pool)

  return counted?.rows ?? 0
}
