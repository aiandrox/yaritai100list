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
 * 数量だけが違う代表表現を1つの束にするためのキー（#337）。
 *
 * 🔴 **数字の並びを1つの `#` に潰す。** 「体重を70kgにする」「体重を65kgにする」は
 * どちらも `体重を#kgにする` になり、同じ行にまとまる。桁数が違っても
 * （「10万円」「100万円」）畳んだあとは同じ `#` になる。
 *
 * 🔴 **単位は残す。** 数字だけを消すので「50キロ歩く」（距離）と「75キロ」（体重）は
 * `#キロ歩く` と `#キロ` で別のまま。語尾が違うもの（「カラオケで90点」と
 * 「カラオケで95点を取る」）も別のまま。**まとめるのは「数字以外は同じ」ものだけ**
 * （2026-09-06 の利用者の判断。埋め込みや AI は使わない）。
 *
 * 🔴 **数字だけの代表表現は伏せない。** 「2024」「100」まで `#` にすると
 * **無関係なものが1行に潰れる。** 伏せた結果が `#` と空白しか残らないなら、
 * 代表表現そのものをキーにする（＝今までどおり完全一致）。
 *
 * ⚠️ **SQLite に正規表現が無い**ので、桁ごとの `replace` を10個重ねて数字を `#` にし、
 * さらに `##` → `#` を数回かけて連桁を1つに畳む（本文は `normalizePoolText` 済みで
 * 数字は半角）。5回畳めば 32 桁まで1つになる。代表表現の数字はせいぜい数桁。
 */
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function maskDigitsExpr(column: string): string {
  const toHash = DIGITS.reduce((expr, digit) => `replace(${expr}, '${digit}', '#')`, column)
  return Array.from({ length: 5 }).reduce<string>((expr) => `replace(${expr}, '##', '#')`, toHash)
}

function familyKeyExpr(column: string): string {
  const masked = maskDigitsExpr(column)
  const rest = `replace(replace(${masked}, '#', ''), ' ', '')`
  return `case when ${rest} = '' then ${column} else ${masked} end`
}

const judgedFamilyKey = sql.raw(familyKeyExpr('judged.canonical'))

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
 * 🔴 **`hiddenInShare`（#237）にした項目は、どちらの範囲からも「書いていない」扱いで除く。**
 * 候補にもしないし、人数にも数えない。`writers` は応答に出ないとはいえ、
 * 他人の同じ本文の並び順には影響するため、**隠した本人の分だけそこにも残らないようにする。**
 *
 * ⚠️ **ジャンルも代表表現も `min()` で1つに決めている。** 同じ束に別のジャンルや
 * （数量だけ違う）別の表記が入ることがある。多数決にすると SQL が一段深くなるわりに、
 * **実際にはほぼ揃う。** 大事なのは**毎回同じものを選ぶこと**で、`min()` はそれを満たす。
 *
 * 🔴 **まとめる単位は「数量を伏せた代表表現」**（`familyKeyExpr`。#337）。
 * 「体重を70kgにする」「体重を65kgにする」は1行になり、`min()` で
 * 「体重を65kgにする」が見出しになる。**候補にするのは今までどおり全公開の本文だけ**
 * （`in (...)` は伏せる前の代表表現で引く）。数量を含まない代表表現は完全一致のまま。
 */
const insertPool = sql`
  insert into pool (canonical, genre, writers)
  select
      min(judged.canonical),
      min(judged.genre),
      count(distinct owner.user_id)
    from items as written
    join lists as owner on owner.id = written.list_id
    join wish_texts as judged on judged.raw_text = written.text
   where judged.verdict = 'ok'
     and judged.canonical is not null
     and judged.genre is not null
     and written.hidden_in_share = 0
     and judged.canonical in (
           select public_judged.canonical
             from items as public_written
             join lists as public_owner on public_owner.id = public_written.list_id
             join wish_texts as public_judged on public_judged.raw_text = public_written.text
            where public_judged.verdict = 'ok'
              and public_owner.visibility in (${publicVisibilities})
              and public_written.hidden_in_share = 0
         )
   group by ${judgedFamilyKey}
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
