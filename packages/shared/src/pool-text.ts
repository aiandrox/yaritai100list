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

/**
 * プロンプトの版（#264）。**中身を変えたら必ず上げること。**
 *
 * 🔴 **上げないと、既に判定した本文が古い答えのまま残る。**
 * 差分取得は `wish_texts.model` と `wish_texts.prompt_version` の両方を見ている
 * （`src/pool-judge.ts` の `selectUnjudged`）。モデルだけを見ていた頃は、
 * **プロンプトを直しても直る本文が1つも無かった。**
 *
 * ⚠️ **一括で消して作り直さないこと。** 上げれば1時間に12件ずつ拾い直される。
 * 消すとプールが空になり、戻るのに何日もかかる（`docs/console-settings.md`）。
 *
 * ⚠️ **本番に出していない版で番号を上げないこと。** 番号は
 * 「**本番の行と突き合わせる**」ためにある。出す前に何度書き直しても、
 * 本番から見れば1つの変更でしかない。
 *
 * - 1: 最初（#253）。**この列より前なので、本番の行は null になっている**
 * - 2: 一般化しすぎるのを止めた（#264）
 */
export const POOL_JUDGE_PROMPT_VERSION = 2

/**
 * AI に渡す指示。**プロンプトを画面やハンドラに散らさない。**
 *
 * 🔴 **一番大事なのは「意味を変えないこと」で、まとめることではない**（#264）。
 * 最初の版は「まとめられる代表表現」としか言っておらず、
 * **まとめること自体が目的**だとモデルが解釈して、
 * 「1日スマホなしでどこかに行く」を「スマホをやめる」にした。
 *
 * **まとめ損ねる害より、意味が変わる害の方が大きい。**
 * まとめ損ねれば2行に分かれるだけだが、意味が変われば
 * **取り入れた人のリストに、誰も書いていないことが入る。**
 *
 * 🔴 **実在の文言を例に並べない**（2026-08-11 の利用者の指摘）。
 * 並べると**その語を覚えるだけ**で、例に無い語では効かない。
 * しかも**例の出所と同じデータで測ると、成績が水増しになる。**
 * publishable は「店名の一覧」をやめて
 * 「**（a）誰のことか分かる（b）その人の身の上に触れている、の両方**」という
 * 規則に書き換えた。**プロンプトにも本番データにも無い文言 13 件**で確かめてある。
 *
 * ⚠️ **例が要る場所もある。** canonical の ❌ は、
 * 抽象的な禁止だけでは1件も直らなかった（2026-08-10 に実測）。
 * ただし**コード側のガードで止まる型は例から外した**（`losesMeaning`）。
 * ガードが拾えない2つ（条件の削除・目的語の削除）だけ例を残してある。
 *
 * ⚠️ **未知の文言での実測**（2026-08-11、151件の本番データとは別に用意）:
 * publishable 12/13・canonical 8/9。**100% にはならない。**
 * 残るのは「修飾語がわずかに落ちる」型で、
 * 「別のやりたいことになる」型はガードが止める。
 */
export function poolJudgementPrompt(): string {
  const genres = GENRES.map((genre) => `${genre.slug}（${genre.label}）`).join('、')

  return [
    'あなたは「やりたいことリスト」の項目を、みんなが見る一覧に出してよいか判断します。',
    '次の3つを JSON で返してください。',
    '',
    '1. publishable: 次のどれかなら false（迷ったら false）。',
    '   - **特定の個人の私生活が分かってしまう**',
    '   - 他人を貶める、攻撃する',
    '   - 露骨な性的表現、違法な行為',
    '   - やりたいこととして意味を成さない（意味のない文字列、宣伝）',
    '',
    '   🔴 **1つめは2つとも満たすときだけ false です。**',
    '   （a）**誰のことか分かる**（名前が書いてある、など）',
    '   （b）**その人の身の上に触れている**（関係、私生活）',
    '',
    '   - 「〇〇さんに告白する」→ false（名前があり、関係に触れている）',
    '   - 「〇〇に行く」「〇〇を食べる」「〇〇のライブに行く」→ true',
    '     **行き先・食べ物・催し・作品として扱っているだけ**なので（b）を満たさない',
    '   - 「家族と旅行する」「祖母と出かける」「同姓同名の人に会う」→ true',
    '     **誰のことか分からない**ので（a）を満たさない',
    '',
    '   ⚠️ **人名に見えても、行き先や食べ物なら店・場所です。** 日本の店名には',
    '   人の名字がそのまま使われます。**知らない名前を人だと決めつけないこと。**',
    '   ⚠️ **自分自身のことは何を書いても構いません**（収入、資産、体型、健康）。',
    '',
    '2. canonical: 同じことを書いた他の人と1行にまとめるための代表表現。',
    '',
    '   🔴 **意味を変えないことが最優先です。まとめることでも、短くすることでもありません。**',
    '   **迷ったら元の文をそのまま返してください。** まとめ損ねても害はありませんが、',
    '   意味が変わると別のやりたいことになってしまいます。',
    '',
    '   変えてよいのは**書き方だけ**です:',
    '   - 語尾（「〜したい」「〜すること」→「〜する」）、送り仮名、記号、空白',
    '     例: 「富士山登頂」「富士山に登りたい」→「富士山に登る」',
    '   - 名詞で終わる文には動詞を補う。**元の言葉は1つも削らず、足すだけ。**',
    '     例: 「ピラミッド」→「ピラミッドに行く」、「グランピング」→「グランピングをする」',
    '',
    '   🔴 **消さないこと**（消すと別の意味になります）:',
    '   数や程度（「180度」「47都道府県」「1日」）、条件（「スマホなしで」「家族と」）、',
    '   目的語（「AIで何かを作る」の「何か」）、身につけ続ける言い方',
    '   （「〜できるようになる」「〜をマスターする」）、外来語の表記（YouTube）。',
    '',
    '   🔴 **分からない言葉を、知っている別の言葉に置き換えないこと。**',
    '',
    '   ❌ 「1日スマホなしでどこかに行く」→「スマホをやめる」（まったく別のこと）',
    '   ❌ 「AIで何かを作る」→「AIで作る」（何を作るのか分からない）',
    '   ❌ 「とみたに行く」→「富士山に登る」（知らない店名をすり替えた）',
    '',
    `   **${String(ITEM_TEXT_MAX_LENGTH)}文字以内の日本語**。収まらなければ元の文のまま。`,
    '   🔴 **代表表現にも個人が分かる情報を残さないこと。**',
    '',
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
  const usable = canonical.success && !losesMeaning(canonical.data, normalized)

  return {
    publishable: true,
    canonical: usable ? canonical.data : normalized,
    genre: toGenreSlug(parsed.data.genre),
  }
}

/**
 * 「身につける」「続ける」を表す言い方（#264）。
 *
 * 🔴 **1回やることとは別のこと。** 「だし巻き卵をマスターする」は
 * 「だし巻き卵を作る」ではないし、「180度開脚できるようになる」は「開脚する」ではない。
 * ここが落ちると、**やりたいことの種類が変わる。**
 *
 * ⚠️ **実際に落とされたものを並べてある。** 網羅ではない。
 * 新しい落とし方を見つけたら足す（足すだけで、既存の判定は
 * プロンプトの版を上げれば拾い直される）。
 */
const MASTERY_PHRASES = [
  'ようになる',
  'マスターする',
  '上手くなる',
  'うまくなる',
  '得意になる',
  '習慣をつける',
  '習慣化する',
  '続ける',
]

/**
 * 代表表現が元の文より**意味を失っている**か（#264）。
 *
 * 🔴 **プロンプトだけでは足りない。** 同じプロンプトでも
 * **呼び出しごとに答えが揺れる**（2026-08-10 に実測。「英語を話せるようになる」は
 * 3回中2回 `英語を話す` になった）。プロンプトは平均を上げるだけで、
 * **下限は上げてくれない。** 機械的に分かるものはここで止める。
 *
 * ⚠️ **止めても害が無い**のがこの判定を置ける理由。
 * 止まると名寄せが効かず2行に分かれるだけで、**意味が変わるより安い**
 * （#264 の「まとめ損ねる害より、意味が変わる害の方が大きい」）。
 */
function losesMeaning(canonical: string, normalized: string): boolean {
  return (
    isTruncation(canonical, normalized) ||
    dropsMastery(canonical, normalized) ||
    swapsSubject(canonical, normalized)
  )
}

/**
 * 元の文と**共通する部分がまったく無い**か（#264）。
 *
 * 🔴 **知らない言葉を、知っている別の言葉に置き換えることがある。**
 * 実データで「とみたに行く」（つけ麺屋）が **`富士山に登る`** になった。
 * しかも `富士山に登る` の組に混ざるので、**別のやりたいことが1行に同居する。**
 *
 * 元の文と2文字の並びが1つも共通していなければ、**言い換えではなく別の文。**
 *
 * ⚠️ **正しい名寄せは必ずどこかが残る**（「富士山登頂」→「富士山に登る」は `富士`・`士山`）。
 * 1文字だけの本文は 2 文字の並びを作れないので、そのときは何も止めない。
 */
function swapsSubject(canonical: string, normalized: string): boolean {
  const pairs = (value: string) =>
    new Set(Array.from({ length: value.length - 1 }, (_, i) => value.slice(i, i + 2)))

  const source = pairs(normalized)
  if (source.size === 0) return false

  return [...pairs(canonical)].every((pair) => !source.has(pair))
}

/**
 * 元の文の一部分そのものになっているか。**言葉を削っただけ。**
 *
 * - 「47都道府県を旅する」→「都道府県を旅する」（`47` を削っただけ）
 * - 「家族とハワイに行く」→「ハワイに行く」（`家族と` を削っただけ）
 *
 * 🔴 **正しい名寄せがこれに当たることは無い。**
 * まとめるときは必ず**語尾が書き換わる**（「富士山に登りたい」→「富士山に登る」）ので、
 * 元の文の部分文字列にはならない。
 */
function isTruncation(canonical: string, normalized: string): boolean {
  return canonical !== normalized && normalized.includes(canonical)
}

/**
 * 元にあった「身につける・続ける」の言い方が消えたか。
 *
 * 部分文字列にならないので `isTruncation` では拾えない
 * （「英語を話せるようになる」→「英語を話す」）。
 *
 * ⚠️ **どちらにも同じ言い方が残っていれば通す。**
 * 「英語が話せるようになりたい」→「英語を話せるようになる」は正しい名寄せ。
 */
function dropsMastery(canonical: string, normalized: string): boolean {
  return MASTERY_PHRASES.some(
    (phrase) => normalized.includes(phrase) && !canonical.includes(phrase),
  )
}

/** 知らないジャンルが返ったら `other`。**握り潰さずに置き場を持つ。** */
function toGenreSlug(value: string): GenreSlug {
  return GENRES.some((genre) => genre.slug === value) ? (value as GenreSlug) : FALLBACK_GENRE
}
