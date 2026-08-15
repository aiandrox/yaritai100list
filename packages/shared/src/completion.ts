import { z } from 'zod'

/**
 * 完了日の**粒度**（#279）。
 *
 * 「やったことは記録したいが、日付を覚えていない」に対応するために入れた
 * （2026-08-14 の利用者の要望）。完了を `completed_at` があるかどうかで表していたので、
 * **1日単位で日付を決めない限り「やった」と記録できなかった。**
 *
 * - `day`: 2026/08/14。日まで覚えている
 * - `month`: 2026年8月。月までしか覚えていない
 * - `year`: 2026年。年単位で記録している
 * - `unknown`: 日付なし。**やったことだけを記録する**
 *
 * 🔴 **完了しているかどうかは、この粒度が付いているかで決まる**（`isCompleted`）。
 * `completed_at` で判定すると `unknown`（日付を持たない完了）が未完了に落ちる。
 * 未完了は `null`。
 *
 * 🔴 **真偽値には戻さない**（`PRODUCT_SPEC.md` §3）。「いつ叶えたか」は思い出として
 * 意味があり、今回足したのは**思い出せない場合の逃げ道**。日付を捨てる変更ではない。
 *
 * この配列を唯一の情報源にして、Zod スキーマと D1 のトリガー（`0016`）の両方を作る。
 */
export const COMPLETED_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const

export type CompletedPrecision = (typeof COMPLETED_PRECISIONS)[number]

export const completedPrecisionSchema = z.enum(COMPLETED_PRECISIONS)

/**
 * 日付を持つ粒度。**`unknown` だけが `completed_at` を持たない完了**（#279）。
 *
 * 「日付が無い粒度」を除外で書かないのは `SHARED_VISIBILITIES` と同じ理由。
 * 粒度を1つ足したときに、黙って「日付があるもの」として扱われないようにする。
 */
export const DATED_PRECISIONS = ['day', 'month', 'year'] as const

export type DatedPrecision = (typeof DATED_PRECISIONS)[number]

export function isDatedPrecision(
  precision: CompletedPrecision | null,
): precision is DatedPrecision {
  return precision !== null && (DATED_PRECISIONS as readonly string[]).includes(precision)
}

/**
 * 完了しているか。
 *
 * 🔴 **`completedAt !== null` で判定しない**（#279）。日付なしの完了
 * （粒度 `unknown`）が未完了として扱われ、達成数・OGP・書き出し・画像で別々に事故る。
 */
export function isCompleted(precision: CompletedPrecision | null): boolean {
  return precision !== null
}

/**
 * 完了日を受け渡す文字列（#279）。**形が粒度を表す。**
 *
 * ```
 * 2026-08-14 → day     2026-08 → month     2026 → year
 * ```
 *
 * 🔴 **粒度と日付を別々に受け取らない。** 2つに分けると
 * 「粒度は `year` なのに月まで入っている」という食い違いを、受ける側で毎回考えることになる。
 * 日付なし（`unknown`）は**この文字列の代わりに `null`** を送る。
 *
 * `<input type="date">` の値がそのまま `day` の形なのも都合がよい。
 */
export const completedOnSchema = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)

/**
 * 完了日として扱える**最も古い年**（`<input>` の下限と、打ち間違いの箍）。
 *
 * ⚠️ **これは妥当性の判断ではない。** 「いつ叶えたか」は持ち主のものなので、
 * 過去は原則として断らない（`isFutureCompletedAt`）。ここにあるのは、
 * 年の欄を打ち直す途中に出る `0002` のような値を弾くためだけの下限。
 */
export const COMPLETED_ON_MIN_YEAR = 1900

/**
 * 完了日は**日本時間の暦日**として扱う（2026-08-14 の判断、#279）。
 *
 * 🔴 **端末の時間帯で組み立てない。** `year` / `month` は「その年・その月の頭」の
 * 瞬間を `completed_at` に入れるので、端末の時間帯で組み立てると
 * **UTC+10 以東の端末で入れた「2026年」が、共有ページ（`Asia/Tokyo` 固定）で
 * 2025年として出る**（1月1日 00:00 が前年の12月31日に落ちる）。
 *
 * ここを日本時間に決め打つと、**入れた文字列と出る文字列が必ず一致する**
 * （`parseCompletedOn` → `toCompletedOn` が往復する）。
 * 日本語のサービスなので、閲覧者の時間帯ではなく日本の暦日で揃える。
 *
 * ⚠️ 日本には夏時間が無い（1951年まで）ので、固定の +09:00 で足りる。
 * `COMPLETED_ON_MIN_YEAR` より前は扱わないため、それより古い時間帯の変遷も関係しない。
 */
export const COMPLETED_ON_TIME_ZONE_OFFSET_MS = 9 * 60 * 60 * 1000

const pad2 = (value: number) => String(value).padStart(2, '0')

/** 日本時間での年・月・日。 */
function jstParts(at: Date): { year: number; month: number; day: number } {
  // +09:00 ずらして UTC として読む。`Intl` を使わないのは、
  // 純関数のまま（`TECH_STACK.md` §10）テストで固定したいため
  const shifted = new Date(at.getTime() + COMPLETED_ON_TIME_ZONE_OFFSET_MS)

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * 完了日の文字列 → 粒度と、**その期間の頭の瞬間**（日本時間）。
 *
 * 読めない値は `null`。**画面から来る値も、書き出したファイルの値も信用しない**
 * （`<input>` は手で打てるし、ファイルは編集できる）。
 * 存在しない日（`2026-02-30`）も `null`。**黙って別の日にしない。**
 *
 * 🔴 **返す瞬間は「頭」で揃える**（`year` なら1月1日、`month` ならその月の1日）。
 * 末尾（12月31日）にすると、**今年を `year` で記録した瞬間に未来の日時になり、
 * `isFutureCompletedAt` に弾かれる。**
 */
export function parseCompletedOn(value: string): { precision: DatedPrecision; at: Date } | null {
  const parsed = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value)
  if (parsed === null) return null

  const [, yearPart, monthPart, dayPart] = parsed

  const year = Number(yearPart)
  if (year < COMPLETED_ON_MIN_YEAR) return null

  const precision: DatedPrecision =
    dayPart !== undefined ? 'day' : monthPart !== undefined ? 'month' : 'year'

  const at = new Date(
    Date.UTC(year, Number(monthPart ?? '1') - 1, Number(dayPart ?? '1')) -
      COMPLETED_ON_TIME_ZONE_OFFSET_MS,
  )

  // 存在しない日・月（`2026-02-30` や `2026-13-01`）は繰り上がって別の日になる。
  // 組み立て直したものが元と一致することで確かめる
  if (toCompletedOn(at, precision) !== value) return null

  return { precision, at }
}

/**
 * 年・月・日の**別々の入力**から `completedOn` を組み立てる（#298）。
 *
 * 画面は粒度を選ばせず、**入った値から粒度が決まる**
 * （2026-08-15 の利用者の指示。「選んでから入れる」順序が余計だった）。
 *
 * ```
 * 2026 / 8 / 14 → '2026-08-14'    2026 / 8 / -  → '2026-08'
 * 2026 / -  / -  → '2026'          -    / -  / - → null（日付なし）
 * ```
 *
 * 🔴 **上位が空なら下位は捨てる。** 「月が空なのに日だけある」を持ち上げない。
 * 🔴 **存在しない日になったら1段落とす**（`2023-02-29` は `2023-02`）。
 * 年を変えたときに起きるので、**黙って別の日にしない**ためにここで受ける。
 *
 * ⚠️ **未来は見ない**（`now` を読まないため）。選ばせない工夫は画面側、
 * 本当に弾くのはサーバー（`isFutureCompletedAt`）。
 */
export function buildCompletedOn(parts: {
  year: string
  month: string
  day: string
}): string | null {
  const { year, month, day } = parts

  if (!/^\d{4}$/.test(year) || Number(year) < COMPLETED_ON_MIN_YEAR) return null
  if (month === '') return year

  const withMonth = `${year}-${month}`
  if (parseCompletedOn(withMonth) === null) return year
  if (day === '') return withMonth

  const withDay = `${withMonth}-${day}`

  return parseCompletedOn(withDay) === null ? withMonth : withDay
}

/**
 * その年月の日数（#298）。日の選択肢を作るために使う。
 *
 * 読めない年月には `0`（選択肢が空になる）。うるう年は `Date` に任せる
 * （`Date.UTC(2024, 2, 0)` = 2024-02-29）。
 */
export function daysInMonth(year: string, month: string): number {
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month)) return 0

  const monthNumber = Number(month)
  if (monthNumber < 1 || monthNumber > 12) return 0

  return new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate()
}

/**
 * 逆向き。**`<input>` に入れる値**と、往復の検算に使う。
 *
 * 日付を持たない粒度（`unknown`）と未完了は `null`。
 */
export function toCompletedOn(
  completedAt: Date | null,
  precision: CompletedPrecision | null,
): string | null {
  if (completedAt === null || !isDatedPrecision(precision)) return null

  const { year, month, day } = jstParts(completedAt)

  if (precision === 'year') return String(year)
  if (precision === 'month') return `${String(year)}-${pad2(month)}`

  return `${String(year)}-${pad2(month)}-${pad2(day)}`
}

/**
 * 画面に出す完了日（#279）。**粒度ごとに出す情報を変える。**
 *
 * ```
 * day → 2026/08/14      month → 2026年8月      year → 2026年
 * unknown・未完了 → ''（何も出さない）
 * ```
 *
 * 🔴 **日付なしのときに「達成済」などを足さない**（2026-08-14 の判断、#279）。
 * 完了は打ち消し線・✓・達成数が伝えているので、日付の欄には何も出さない。
 *
 * ⚠️ **`Intl` を使わない。** サーバー（共有ページ）とクライアントで
 * 同じ文字列が出ることを保証したいので、自分で組む
 * （`Intl` の出力は実行環境の CLDR の版で変わりうる）。
 * `day` の形は `ja-JP` の `dateStyle: 'medium'` と同じ `2026/08/14`。
 */
export function formatCompletedOn(
  completedAt: Date | null,
  precision: CompletedPrecision | null,
): string {
  if (completedAt === null || !isDatedPrecision(precision)) return ''

  const { year, month, day } = jstParts(completedAt)

  if (precision === 'year') return `${String(year)}年`
  if (precision === 'month') return `${String(year)}年${String(month)}月`

  return `${String(year)}/${pad2(month)}/${pad2(day)}`
}
