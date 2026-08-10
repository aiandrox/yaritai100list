import { z } from 'zod'

import { ITEM_TEXT_MAX_LENGTH } from './limits'
import { itemTextSchema } from './validation'

/**
 * 取り入れ面に出す本文の下ごしらえ（#253 / 親 #252）。
 *
 * **プールに出すときだけ**掛ける処理を集める。
 * 🔴 **書くときの制約は増やさない**（`PRODUCT_SPEC.md` §1「思い立った瞬間に書ける」）。
 * `itemTextSchema` は変えない。
 */

/**
 * 表記を揃える。**AI を使わない決定的な処理。**
 *
 * - NFKC 正規化（`ＹｏｕＴｕｂｅ` → `YouTube`、`１００` → `100`、`ｶﾀｶﾅ` → `カタカナ`）
 * - 前後の空白を落とし、連続する空白を1つにする
 *
 * ⚠️ **小文字化はしない。** `YouTube` と `youtube` を同じにしたくなるが、
 * **元の本文をそのまま出すことがある**（代表表現が作れなかったときの受け皿）ので、
 * 見た目を壊す変換はここでしない。表記の違いは代表表現の側で吸収する。
 */
export function normalizePoolText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/**
 * ジャンル（#255 で入口にする）。
 *
 * 🔴 **スラッグを持つ。** URL に入れるので、日本語のラベルをそのまま使わない。
 *
 * `other` は**入口に出さない**。分類できなかったことを握り潰さないために持つが、
 * 「その他」を眺めに来る人はいない。
 */
export const GENRES = [
  { slug: 'travel', label: '旅行' },
  { slug: 'work', label: '仕事・キャリア' },
  { slug: 'learning', label: '学び' },
  { slug: 'hobby', label: '趣味・遊び' },
  { slug: 'food', label: '食' },
  { slug: 'health', label: '健康・からだ' },
  { slug: 'people', label: '人・家族' },
  { slug: 'living', label: '暮らし' },
  { slug: 'money', label: 'お金' },
  { slug: 'challenge', label: '挑戦・体験' },
  { slug: 'other', label: 'その他' },
] as const

export type GenreSlug = (typeof GENRES)[number]['slug']

/** 分類できなかったときの行き先。 */
export const FALLBACK_GENRE: GenreSlug = 'other'

/** 入口に出すジャンル。**`other` を除く。** */
export const BROWSABLE_GENRES = GENRES.filter((genre) => genre.slug !== FALLBACK_GENRE)

/**
 * 取り入れ面で絞り込めるジャンル（#255）。
 *
 * 🔴 **`other` を受け付けない。** 入口に出さないものを URL からだけ開けると、
 * **分類に失敗したものを集めた画面**が生まれる。持ち帰る人はいないし、
 * 「AI がうまく分類できなかったもの」を並べて見せる意味も無い。
 *
 * ⚠️ **ラベルではなくスラッグを受ける。** 日本語を URL に入れない。
 */
export const genreSlugSchema = z.enum(
  BROWSABLE_GENRES.map((genre) => genre.slug) as [string, ...string[]],
)

/** そのスラッグの表示名。知らないものは `undefined`。 */
export function genreLabel(slug: string): string | undefined {
  return GENRES.find((genre) => genre.slug === slug)?.label
}

/**
 * AI に返させる形。
 *
 * ⚠️ **Workers AI は「スキーマ通りに返る保証はない」と明記している。**
 * だから受け取った後にここで検証する。外れたら出さない（`judgePoolText`）。
 */
export const poolJudgementSchema = z.object({
  /**
   * 公開してよいか。
   *
   * **元の本文と、作った代表表現の両方**についての判断（プロンプトでそう聞く）。
   * 別々に2回聞かないのは、代表表現は元の一般化なので**同じモデルに2回聞いても
   * 増える情報が無い**ため。
   */
  publishable: z.boolean(),
  canonical: z.string(),
  genre: z.string(),
})

/** AI に渡す指示。**プロンプトを画面やハンドラに散らさない。** */
export function poolJudgementPrompt(): string {
  const genres = GENRES.map((genre) => `${genre.slug}（${genre.label}）`).join('、')

  return [
    'あなたは「やりたいことリスト」の項目を、みんなが見る一覧に出してよいか判断します。',
    '',
    '次の3つを JSON で返してください。',
    '',
    '1. publishable: 次のどれかに当たるなら false。**迷ったら false。**',
    '   - 特定の個人が分かる（人名、団体名と個人の組み合わせ、連絡先など）',
    '   - 他人を貶める、攻撃する',
    '   - 露骨な性的表現、違法な行為',
    '   - やりたいこととして意味を成さない（意味のない文字列、宣伝）',
    '2. canonical: 同じことを言っている他の書き方とまとめられる代表表現。',
    `   **${String(ITEM_TEXT_MAX_LENGTH)}文字以内の日本語**。「〜する」の形にそろえる。`,
    '   例: 「富士山登頂」「富士山に登りたい」→「富士山に登る」',
    '   🔴 **代表表現にも個人が分かる情報を残さないこと。**',
    `3. genre: 次のどれか1つのスラッグ。当てはまらなければ ${FALLBACK_GENRE}。`,
    `   ${genres}`,
  ].join('\n')
}

/** 判定の結果。**出さないと決めた理由は持たない**（本人に伝えないため。#252）。 */
export type PoolJudgement =
  { publishable: false } | { publishable: true; canonical: string; genre: GenreSlug }

/**
 * AI の応答を、保存してよい形に落とす。**純関数**（`TECH_STACK.md` §10）。
 *
 * 🔴 **迷ったら出さない**（2026-08-10 の利用者の判断）。
 * 読めない応答・`publishable` でないものは、すべて「出さない」に倒す。
 * **出してはいけないものが出る方が、出せるものが出ないより高くつく。**
 *
 * @param normalized 正規化済みの元の本文。**代表表現が使えないときの受け皿。**
 */
export function toPoolJudgement(raw: unknown, normalized: string): PoolJudgement {
  const parsed = poolJudgementSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.publishable) return { publishable: false }

  /**
   * 🔴 **代表表現は `itemTextSchema` を通す。**
   *
   * 取り入れると**人のリストに入る**ので、手で書いたものと同じ制約を満たす必要がある。
   * 長すぎる・空、といった応答をそのまま保存すると、取り入れた瞬間に弾かれる。
   *
   * 通らなければ**実際に書かれた表記に落とす。** 名寄せは効かなくなるが、
   * **出せなくなるよりはよい**（元の本文は公開してよいと判断されている）。
   */
  const canonical = itemTextSchema.safeParse(normalizePoolText(parsed.data.canonical))

  return {
    publishable: true,
    canonical: canonical.success ? canonical.data : normalized,
    genre: toGenreSlug(parsed.data.genre),
  }
}

/** 知らないジャンルが返ったら `other`。**握り潰さずに置き場を持つ。** */
function toGenreSlug(value: string): GenreSlug {
  return GENRES.some((genre) => genre.slug === value) ? (value as GenreSlug) : FALLBACK_GENRE
}
