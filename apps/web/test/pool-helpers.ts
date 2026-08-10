import { POOL_VISIBILITIES } from '@yaritai100list/shared'
import { eq, inArray } from 'drizzle-orm'

import { items, lists, wishTexts } from '../src/db/schema'
import { rebuildPool } from '../src/pool'
import { POOL_JUDGE_MODEL } from '../src/pool-judge'
import { createTestUser, testDb } from './helpers'

/**
 * 取り入れ面のプールを組み立てるテスト用の道具（#254 / 親 #252）。
 *
 * 🔴 **AI は呼ばない。** テスト環境には AI バインディングが無い
 * （`wrangler.jsonc` の `env.test`）。判定は**結果を直接書く**ことで作る。
 * AI の呼び出しそのものは `pool-judge.test.ts` が見る。
 */

/** AI が返す判定。省略した項目は「そのまま通す」（本文がそのまま代表表現になる）。 */
export interface Judgement {
  verdict?: 'ok' | 'ng'
  canonical?: string
  genre?: string
}

/**
 * 公開範囲を指定してリストを作り、項目を入れる。
 *
 * **持ち主を分けられるようにしてある**（人数で並べるため）。
 */
export async function makeList(options: {
  id: string
  visibility: 'private' | 'unlisted' | 'public'
  texts: string[]
  userId?: string
}) {
  const db = testDb()
  const userId = options.userId ?? (await createTestUser(`${options.id}@example.com`))

  await db.insert(lists).values({
    id: options.id,
    userId,
    title: 'x',
    visibility: options.visibility,
    shareId: crypto.randomUUID().replaceAll('-', ''),
  })

  const rows = options.texts.map((text, position) => ({
    id: `${options.id}-${String(position)}`,
    listId: options.id,
    text,
    position,
  }))

  // ⚠️ **1文にまとめない。** D1 はバインド変数の数に上限があり、
  // 100件を1文で入れると `too many SQL variables` で落ちる（#89 で踏んだのと同じ）
  for (let i = 0; i < rows.length; i += 20) {
    await db.insert(items).values(rows.slice(i, i + 20))
  }

  return { userId }
}

/**
 * バッチを1回まわす。**判定を埋めてからプールを作り直す。**
 *
 * 🔴 **判定を付けるのは全公開リストにある本文だけ**（本物の `selectUnjudged` と同じ）。
 * 非公開リストの本文は AI に送らないので、**判定が無いのが正しい状態。**
 * その状態でどう振る舞うかを見たいテストがあるので、ここで手を抜かない。
 *
 * `judgements` に書いた本文は、**全公開リストに無くても**その通りに判定される
 * （非公開の本文に判定がある状況を作るため）。
 *
 * ⚠️ **既にある判定は上書きしない。** 先に `runBatch({ ... })` で細工しておいて、
 * あとから `runBatch()` を呼んでも細工が残る。
 */
export async function runBatch(judgements: Record<string, Judgement> = {}): Promise<void> {
  const db = testDb()

  const published = await db
    .selectDistinct({ text: items.text })
    .from(items)
    .innerJoin(lists, eq(lists.id, items.listId))
    .where(inArray(lists.visibility, [...POOL_VISIBILITIES]))

  await judge(
    new Set([...published.map((row) => row.text), ...Object.keys(judgements)]),
    judgements,
  )
  await rebuildPool(db)
}

async function judge(texts: Set<string>, judgements: Record<string, Judgement>): Promise<void> {
  const db = testDb()

  for (const rawText of texts) {
    const { verdict = 'ok', canonical = rawText, genre = 'other' } = judgements[rawText] ?? {}

    await db
      .insert(wishTexts)
      .values({
        rawText,
        verdict,
        canonical: verdict === 'ok' ? canonical : null,
        genre: verdict === 'ok' ? genre : null,
        model: POOL_JUDGE_MODEL,
        checkedAt: new Date(),
      })
      .onConflictDoNothing()
  }
}
