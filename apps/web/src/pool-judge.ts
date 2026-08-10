import {
  normalizePoolText,
  POOL_VISIBILITIES,
  poolJudgementPrompt,
  toPoolJudgement,
  type PoolJudgement,
} from '@yaritai100list/shared'
import { eq, inArray } from 'drizzle-orm'

import type { Db } from './db'
import { items, lists, wishTexts } from './db/schema'

/**
 * 取り入れ面に出してよいかを AI に判定させ、`wish_texts` に貯める（#253 / 親 #252）。
 *
 * 🔴 **プールを作るのはここではない**（#254 の日次バッチ）。
 * ここは「まだ判定していない本文に判定を付ける」だけ。
 *
 * ⚠️ **少しずつしか処理できない。** Cloudflare Free では
 * **サブリクエストが1実行あたり 50**（2026-08-10 に確認）。
 * 1件につき AI 1回 + 書き込み1回なので、1回のバッチで捌けるのは十数件。
 * **細かい間隔で回して追いつかせる**（`wrangler.jsonc` の `triggers`）。
 */

/**
 * 1回のバッチで判定する本文の数。
 *
 * ⚠️ **サブリクエストの上限（50/実行）から決めている。**
 * 増やすと途中で打ち切られ、**何件処理できたのか分からないまま失敗する。**
 */
export const POOL_JUDGE_BATCH_SIZE = 15

/**
 * Workers AI のモデル。
 *
 * 🔴 **JSON モードに対応しているものを選ぶ**（2026-08-10 に確認）。
 * ⚠️ ただし Cloudflare 自身が「**スキーマ通りに返る保証はない**」と書いているので、
 * 受け取った後に必ず検証する（`toPoolJudgement`）。
 *
 * ⚠️ **モデルは非推奨になる。** 最初に選んだ `llama-3.1-8b-instruct` は
 * **2026-05-30 に非推奨**になっていて、呼ぶと 5028 で落ちた（2026-08-10 に踏んだ）。
 * 落ちたときは保存しないので `ng` が焼き付くことはないが、
 * **判定が全く進まなくなる。** ログの `pool-judge: failed=` を見ること。
 *
 * ⚠️ **変えたら判定を貼り直す。** `wish_texts` はキャッシュなので、消せば作り直される:
 * `wrangler d1 execute DB --remote --command "delete from wish_texts"`
 *
 * 手元で確かめた結果（2026-08-10）:
 * - 「富士山登頂」「富士山に登りたい」→ どちらも `富士山に登る` に寄った
 * - 「田中太郎に告白する」→ `ng`
 */
export const POOL_JUDGE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

/** AI に渡す形。**呼び出し側から組み立てを見えなくする。** */
export function poolJudgeInput(normalized: string) {
  return {
    messages: [
      { role: 'system', content: poolJudgementPrompt() },
      { role: 'user', content: normalized },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          publishable: { type: 'boolean' },
          canonical: { type: 'string' },
          genre: { type: 'string' },
        },
        required: ['publishable', 'canonical', 'genre'],
      },
    },
  } as const
}

/**
 * まだ判定していない本文を取る。
 *
 * **全公開リストにある本文だけ**（`POOL_VISIBILITIES`）。
 * 非公開のものまで AI に送ると、**出す予定の無い本文を外に出す**ことになる。
 *
 * 🔴 **正規化した形で重複を落とす。** `ＹｏｕＴｕｂｅ` と `YouTube` に
 * 2回 AI を使わない。
 */
export async function selectUnjudged(db: Db, limit: number): Promise<string[]> {
  /**
   * 🔴 **正規化は JS 側でやる**（`normalizePoolText` が唯一の情報源）。
   * SQL で同じことを書くと、NFKC の細かい違いで**2箇所がずれる。**
   *
   * そのため「まだ判定していないもの」を SQL だけでは絞れない。
   * **多めに取ってから JS で絞る。** 候補は多くても項目の数なので、これで足りる。
   */
  const rows = await db
    .selectDistinct({ text: items.text })
    .from(items)
    .innerJoin(lists, eq(lists.id, items.listId))
    .where(inArray(lists.visibility, [...POOL_VISIBILITIES]))

  const candidates = [...new Set(rows.map((row) => normalizePoolText(row.text)))].filter(
    (text) => text !== '',
  )
  if (candidates.length === 0) return []

  const judged = await db
    .select({ normalized: wishTexts.normalized })
    .from(wishTexts)
    .where(inArray(wishTexts.normalized, candidates))

  const done = new Set(judged.map((row) => row.normalized))

  return candidates.filter((text) => !done.has(text)).slice(0, limit)
}

/** 判定を1件保存する。 */
export function saveJudgement(db: Db, normalized: string, judgement: PoolJudgement) {
  return db
    .insert(wishTexts)
    .values({
      normalized,
      verdict: judgement.publishable ? 'ok' : 'ng',
      canonical: judgement.publishable ? judgement.canonical : null,
      genre: judgement.publishable ? judgement.genre : null,
      checkedAt: new Date(),
    })
    .onConflictDoNothing()
}

/**
 * まだ判定していない本文を、少しずつ判定して貯める。
 *
 * 🔴 **1件失敗しても止めない。** モデルが落ちた・応答が読めなかった、で
 * バッチ全体が止まると**永久に追いつかない。**
 * 読めなかったものは `toPoolJudgement` が「出さない」に倒す。
 *
 * ⚠️ **AI の呼び出しが失敗した場合は保存しない**（次のバッチで再挑戦する）。
 * 「出さない」として保存すると、**一時的な障害が恒久的な除外になる。**
 */
export async function judgeUnjudged(
  db: Db,
  ai: { run: (model: string, input: unknown) => Promise<unknown> },
  limit = POOL_JUDGE_BATCH_SIZE,
): Promise<{ judged: number; failed: number }> {
  const targets = await selectUnjudged(db, limit)
  let judged = 0
  let failed = 0

  for (const normalized of targets) {
    let raw: unknown
    try {
      raw = await ai.run(POOL_JUDGE_MODEL, poolJudgeInput(normalized))
    } catch (error) {
      // 呼び出せなかっただけ。**除外として保存しない**
      console.error(`pool-judge: ${String(error)}`)
      failed += 1
      continue
    }

    await saveJudgement(db, normalized, toPoolJudgement(toResponseObject(raw), normalized))
    judged += 1
  }

  return { judged, failed }
}

/**
 * Workers AI の応答から中身を取り出す。
 *
 * ⚠️ **`response` は JSON の**文字列**で返ることがある**（モデルによる）。
 * オブジェクトで来ることもあるので、両方を受ける。
 * 読めなければ `undefined` を返し、`toPoolJudgement` に「出さない」と判断させる。
 */
function toResponseObject(raw: unknown): unknown {
  const response = (raw as { response?: unknown }).response

  if (typeof response !== 'string') return response

  try {
    return JSON.parse(response)
  } catch {
    return undefined
  }
}
