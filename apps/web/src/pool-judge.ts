import {
  normalizePoolText,
  POOL_VISIBILITIES,
  poolJudgementPrompt,
  toPoolJudgement,
  type PoolJudgement,
} from '@yaritai100list/shared'
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

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
 * 🔴 **モデルを変えても `wish_texts` を一括で消さないこと。**
 * 消せば作り直されるが、**判定は1日 360 件しか進まない**（Neurons の枠）。
 * その間**プールが空になる**（プールは `wish_texts` から作り直すため）。
 * 1万件あれば28日間、取り入れ面が空になる。
 *
 * **ここの値を書き換えるだけでよい**（#254）。`wish_texts.model` と突き合わせて
 * 古い行を少しずつ拾い直す（`selectUnjudged`）。**上書きされるまで古い判定が使われる**ので、
 * 入れ替えの最中もプールは埋まったままになる。
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
 * 判定が要る本文を取る。**まだ判定していないもの、または古いモデルで判定したもの。**
 *
 * **全公開リストにある本文だけ**（`POOL_VISIBILITIES`）。
 * 非公開のものまで AI に送ると、**出す予定の無い本文を外に出す**ことになる。
 *
 * 🔴 **SQL だけで絞る。** `wish_texts` のキーが「書かれたままの本文」なので、
 * 突き合わせが `left join` で済む。
 * **JS が触るのは取ってきた十数件だけ。**
 *
 * ⚠️ **正規化した形をキーにしていたときは、全公開項目を全部 JS に読み込んで
 * 正規化していた。** 項目が増えると**定期実行の CPU 10ms（Free）を超える。**
 *
 * 🔴 **まだ判定していないものを先に処理する**（#254）。
 * モデルを変えた直後は「古いモデルの行」が何千件も並ぶ。順番を決めないと、
 * **その日に書かれた新しい本文が何日もプールに出てこない。**
 * 判定し直しは**プールに既に出ているもの**の作り直しなので、後回しでよい。
 */
export async function selectUnjudged(db: Db, limit: number): Promise<string[]> {
  // null（この列より前に入った行）も「古い」として拾う
  const stale = or(isNull(wishTexts.model), ne(wishTexts.model, POOL_JUDGE_MODEL))

  const rows = await db
    .selectDistinct({
      text: items.text,
      // まだ判定していないもの = 0 が先
      unjudged: sql<number>`case when ${wishTexts.rawText} is null then 0 else 1 end`,
    })
    .from(items)
    .innerJoin(lists, eq(lists.id, items.listId))
    .leftJoin(wishTexts, eq(wishTexts.rawText, items.text))
    .where(
      and(inArray(lists.visibility, [...POOL_VISIBILITIES]), or(isNull(wishTexts.rawText), stale)),
    )
    .orderBy(asc(sql`case when ${wishTexts.rawText} is null then 0 else 1 end`))
    .limit(limit)

  return rows.map((row) => row.text)
}

/**
 * 判定を1件保存する。**キーは書かれたままの本文。**
 *
 * 🔴 **既にある行は上書きする**（#254）。以前は何もしないようにしていたが、
 * それだと**モデルを変えても古い判定が永久に残る。**
 * 上書きは「AI が答えを返せたとき」しか呼ばれない（`judgeUnjudged`）ので、
 * **失敗が古い判定を壊すことは無い。**
 */
export function saveJudgement(db: Db, rawText: string, judgement: PoolJudgement) {
  const row = {
    verdict: judgement.publishable ? 'ok' : 'ng',
    canonical: judgement.publishable ? judgement.canonical : null,
    genre: judgement.publishable ? judgement.genre : null,
    model: POOL_JUDGE_MODEL,
    checkedAt: new Date(),
  }

  return db
    .insert(wishTexts)
    .values({ rawText, ...row })
    .onConflictDoUpdate({ target: wishTexts.rawText, set: row })
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
): Promise<{ judged: number; failed: number; lastError?: unknown }> {
  const targets = await selectUnjudged(db, limit)
  let judged = 0
  let failed = 0
  let lastError: unknown

  for (const rawText of targets) {
    // 🔴 **AI には正規化したものを見せる。** 保存のキーは書かれたままの本文
    const normalized = normalizePoolText(rawText)
    let raw: unknown

    try {
      raw = await ai.run(POOL_JUDGE_MODEL, poolJudgeInput(normalized))
    } catch (error) {
      // 呼び出せなかっただけ。**除外として保存しない**
      console.error(`pool-judge: ${String(error)}`)
      lastError = error
      failed += 1
      continue
    }

    await saveJudgement(db, rawText, toPoolJudgement(toResponseObject(raw), normalized))
    judged += 1
  }

  return { judged, failed, ...(lastError === undefined ? {} : { lastError }) }
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
