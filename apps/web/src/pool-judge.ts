import {
  normalizePoolText,
  POOL_JUDGE_PROMPT_VERSION,
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
 * 🔴 **無料枠のサブリクエスト上限から決めている**（Cloudflare Free は
 * **1実行あたり 50**、2026-08-10 に確認）。1件につき Gemini へ fetch 1回 + D1 書き込み1回
 * なので 12 件で約 24。倍以上の余地はあるが、プールの作り直しは急がないので詰めない。
 *
 * ⚠️ **コストの目安**（#342 の検証で実測。`gemini-3.5-flash-lite`、いまのプロンプト）:
 * **入力 約 800 トークン・出力 約 25 トークン/件。** 12 件/時 × 24 = 288 件/日 で
 * 月およそ 入力 7.5M / 出力 0.25M トークン ≒ **月 $1〜3**。
 * 暗黙のプロンプトキャッシュ（同一システムプロンプト）で入力側はさらに下がる。
 *
 * 🔴 **プロンプトを長くしたら入力トークンが増える。** コストと件数は連動する。
 * ⚠️ **Neurons の枠はもう関係ない**（Workers AI をやめた。#342）。
 */
export const POOL_JUDGE_BATCH_SIZE = 12

/**
 * 判定に使うモデル（#342）。**Google AI Studio の Gemini API。**
 *
 * 🔴 **Workers AI（Llama 3.3 70B fp8）から移した理由は文字化け**（#336 / #340）。
 * fp8 量子化＋日本語の弱さで canonical を別字に化けさせる事故が本番で ~18/250 出ていた。
 * #342 の検証（本番 `wish_texts` 250 行）で `gemini-3.5-flash-lite` は
 * **化け 0/250**・プライバシー判定は Llama 以上・外し方は「正規化しなさすぎ」側で
 * #264 的に安全、と確認した。
 *
 * ⚠️ **`responseSchema` で JSON を強制するが**、Google 自身「スキーマ通りに返る保証はない」
 * としているので受けた後に必ず検証する（`toPoolJudgement`）。
 *
 * ⚠️ **モデルは提供終了する。** `gemini-2.5-flash-lite` は #342 の検証中に
 * 「新規ユーザーには提供しない」で 404 になった。落ちても保存しないので `ng` が
 * 焼き付くことはないが判定が止まる。ログの `pool-judge: ... すべて失敗した` を見ること。
 *
 * 🔴 **モデルを変えても `wish_texts` を一括で消さないこと**（#254）。値を書き換えるだけで
 * `selectUnjudged` が `wish_texts.model` と突き合わせて古い行を少しずつ拾い直す。
 * **上書きされるまで古い判定が使われる**ので、入れ替え中もプールは埋まったまま。
 */
export const POOL_JUDGE_MODEL = 'gemini-3.5-flash-lite'

/** Gemini API のベース URL。キーはクエリで渡す（Google のやり方）。 */
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

/**
 * AI に渡す形（#342）。**呼び出し側から組み立てを見えなくする。**
 *
 * Gemini `generateContent` の body。`responseSchema` で JSON を強制し、
 * `temperature: 0` で呼び出しごとの揺れを抑える。
 */
export function poolJudgeInput(normalized: string) {
  return {
    systemInstruction: { parts: [{ text: poolJudgementPrompt() }] },
    contents: [{ role: 'user', parts: [{ text: normalized }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          publishable: { type: 'boolean' },
          canonical: { type: 'string' },
          genre: { type: 'string' },
        },
        required: ['publishable', 'canonical', 'genre'],
      },
      temperature: 0,
    },
  } as const
}

/** 判定に必要なシークレット。**`Env` に入らない**ので他の秘密と同じくここで宣言する。 */
export interface PoolJudgeEnv {
  /**
   * Google AI Studio の Gemini API キー（#342。`wrangler secret`）。
   * **無ければ判定バッチは動かない**（プールは古い判定のまま。`index.ts` の `runPoolBatch`）。
   */
  readonly GEMINI_API_KEY?: string
}

/** 判定を1件返すもの。**HTTP を `judgeUnjudged` から切り離す**（テストで差し替える）。 */
export interface PoolJudge {
  run(input: unknown): Promise<unknown>
}

/**
 * Gemini API を叩く `PoolJudge`。
 *
 * 🔴 **キーはクエリに載る。** 失敗時に URL や本文をログに出さない（status だけ）。
 * ⚠️ **失敗は投げる。** `judgeUnjudged` が捕まえて「保存しない」に倒す
 * （一時的な失敗が恒久的な除外にならないように）。
 */
export function createGeminiJudge(apiKey: string, model = POOL_JUDGE_MODEL): PoolJudge {
  return {
    async run(input: unknown): Promise<unknown> {
      const res = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })

      if (!res.ok) throw new Error(`gemini ${String(res.status)}`)

      return res.json()
    },
  }
}

/**
 * 判定が要る本文を取る。
 * **まだ判定していないもの、または古いモデル・古いプロンプトで判定したもの。**
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
  /**
   * 判定し直しが要る行。
   *
   * 🔴 **モデルとプロンプトの両方を見る**（#264）。
   * モデルだけを見ていたときは、**プロンプトを直しても直る本文が1つも無かった。**
   *
   * null（それぞれの列より前に入った行）も「古い」として拾う。
   */
  const stale = or(
    isNull(wishTexts.model),
    ne(wishTexts.model, POOL_JUDGE_MODEL),
    isNull(wishTexts.promptVersion),
    ne(wishTexts.promptVersion, POOL_JUDGE_PROMPT_VERSION),
  )

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
 *
 * 🔴 **何で判定したかを必ず一緒に書く**（モデルとプロンプトの版。#264）。
 * 書き忘れると、次に何を直しても**その行だけ拾い直されない。**
 */
export function saveJudgement(db: Db, rawText: string, judgement: PoolJudgement) {
  const row = {
    verdict: judgement.publishable ? 'ok' : 'ng',
    canonical: judgement.publishable ? judgement.canonical : null,
    genre: judgement.publishable ? judgement.genre : null,
    model: POOL_JUDGE_MODEL,
    promptVersion: POOL_JUDGE_PROMPT_VERSION,
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
  judge: PoolJudge,
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
      raw = await judge.run(poolJudgeInput(normalized))
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
 * Gemini の応答から中身を取り出す（#342）。
 *
 * `candidates[0].content.parts[].text` が JSON 文字列。思考する版だと思考パートが
 * 混ざるので `thought` でないテキストを拾う。
 * 読めなければ `undefined` を返し、`toPoolJudgement` に「出さない」と判断させる。
 */
function toResponseObject(raw: unknown): unknown {
  const parts =
    (
      raw as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[]
      }
    ).candidates?.[0]?.content?.parts ?? []

  const text = parts.find((part) => typeof part.text === 'string' && part.thought !== true)?.text

  if (typeof text !== 'string') return undefined

  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
