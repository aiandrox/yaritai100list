/**
 * クライアントのロジックのうち、**DOM を触らない部分**。
 *
 * ここだけをテストする（`TECH_STACK.md` §10 の方針。#43 で決定）。
 * テストは workerd の中で走るので、**このファイルに DOM の API を持ち込まないこと。**
 * 持ち込むとテストが落ちる。描画と配線は `*.tsx` 側に置く。
 *
 * **時刻と ID もここでは作らない。** `Date.now()` や `crypto.randomUUID()` を
 * 関数の中で呼ぶと、戻り値が呼ぶたびに変わってテストで固定できない。
 * 呼び出し側（`*.tsx`）が作って引数で渡す。
 */

import {
  type CompletedPrecision,
  completedPrecisionSchema,
  DEFAULT_LIST_TITLE,
  isCompleted,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  itemTextSchema,
  LIST_TITLE_MAX_LENGTH,
  listTitleSchema,
} from '@yaritai100list/shared'
import { z } from 'zod'

/**
 * ログイン状態。
 *
 * **`error` を `anonymous` に混ぜないこと。** 混ぜると、
 * セッションの取得に失敗しただけなのに「未ログイン」として扱われ、
 * ログイン済みの利用者にログインの導線を出してしまう。逆に `authenticated` に
 * 倒すと、未ログインの利用者からログインの導線が消える。**どちらも詰む。**
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated' }
  | { status: 'error' }

/**
 * `GET /api/auth/get-session` の応答からログイン状態を決める。
 *
 * Better Auth はログイン中なら `{ session, user }` を、未ログインなら `null` を
 * **どちらも 200 で**返す。したがって**状態は本文で見分ける**。
 *
 * 🔴 **HTTP の失敗を「未ログイン」として扱わない。**
 * `null` かどうかだけで判定すると、500 の応答（本文はエラーオブジェクト）が
 * `authenticated` になり、**障害中にログインの導線が消える。**
 * Better Auth 側にも内部エラーを `null` に潰す不具合があり
 * （better-auth#10566。#3 に記録）、区別できるのは HTTP の状態までなので、
 * **せめてそこは落とさない。**
 */
export function toSessionState(response: { ok: boolean; body: unknown }): SessionState {
  if (!response.ok) return { status: 'error' }
  if (response.body === null) return { status: 'anonymous' }

  // 200 なのに想定外の形。ログイン中と決めつけない
  if (typeof response.body !== 'object' || !('user' in response.body)) {
    return { status: 'error' }
  }

  return { status: 'authenticated' }
}

/**
 * 「やった」印を付けられるか（`PRODUCT_SPEC.md` §2、2026-08-07 決定）。
 *
 * **未ログインでは完了にできない。** 完了は後から見返して意味を持つ記録なので、
 * ブラウザにしか無い状態で貯めても消える。**消えて困るものを貯め始める地点を
 * ログインに合わせる**、というのが理由。書くこと自体には障壁を作らない。
 *
 * 🔴 **`error` を「できる」に倒さない。** ログイン状態が分からないだけなのに
 * 印を付けられると、ログインしていない人の完了がブラウザに残る。
 * かといって「未ログイン」と同じ文言を出すと、ログイン済みの人に
 * ログインを促すことになる。**理由を分けて返し、文言も分ける。**
 */
export type CompletionPermission =
  | { allowed: true }
  | { allowed: false; reason: 'sign-in-required' | 'session-loading' | 'session-unknown' }

export function toCompletionPermission(session: SessionState): CompletionPermission {
  switch (session.status) {
    case 'authenticated':
      return { allowed: true }
    case 'anonymous':
      return { allowed: false, reason: 'sign-in-required' }
    case 'loading':
      return { allowed: false, reason: 'session-loading' }
    case 'error':
      return { allowed: false, reason: 'session-unknown' }
  }
}

/**
 * `POST /api/auth/sign-out` に送る内容。**`App.tsx` とテストで同じものを使う。**
 *
 * 🔴 **`content-type: application/json` と本文 `{}` の両方が要る。**
 * 素の `fetch(url, { method: 'POST' })` は本番で **415** になる（実際に踏んだ）。
 *
 * better-call の本文パーサ（`better-call/dist/utils.mjs`）はこう書かれている:
 *
 * ```js
 * if (!request.body) return                                  // 本文が無ければ素通し
 * if (!normalizedContentType) throw new APIError(415, ...)   // 本文があるのに content-type が無い
 * ```
 *
 * ブラウザは本文の無い POST でも `Content-Length: 0` を送るため、Workers 側からは
 * **空ストリームの「本文あり」**に見えて 415 に落ちる。
 * 一方 `new Request(url, { method: 'POST' })` は `body` が `null` なので素通しし、
 * **テストだけ 200 になる。** テストからこの定義を使うのは、その差を作らないため。
 *
 * `content-type` だけ付けて本文を空にすると、今度は `request.json()` が
 * SyntaxError になり **400** が返る。だから `{}` を送る。
 */
export function signOutRequestInit(): {
  method: string
  headers: Record<string, string>
  body: string
} {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }
}

// ---------------------------------------------------------------------------
// 未ログインで書くリスト（#4 / #72）
// ---------------------------------------------------------------------------

/**
 * やりたいこと1件。
 *
 * **完了は真偽値ではなく日時**（`PRODUCT_SPEC.md` §3）。
 * いつ叶えたかは思い出として意味があるので、`true` に潰さない。
 */
export interface Item {
  /**
   * クライアント内で一意な ID。**呼び出し側が `crypto.randomUUID()` などで作って渡す。**
   *
   * 配列の添字を ID 代わりにしない。途中の項目を消したときに以降の同一性がずれ、
   * React が別の項目を使い回して**入力中のフォーカスや値が隣に飛ぶ。**
   */
  id: string
  text: string
  /**
   * 完了日時（epoch ms）。未完了と**日付なしの完了**（#279）なら `null`。
   *
   * 🔴 **完了しているかはここでは分からない**（#279）。`completedPrecision` で見る。
   */
  completedAt: number | null
  /**
   * 完了日の粒度（#279）。**`null` は未完了。**
   *
   * 未ログインのリストでは常に `null`（未ログインでは印を付けられない。#77）。
   */
  completedPrecision: CompletedPrecision | null
}

/**
 * 未ログインで持てる唯一のリスト（`PRODUCT_SPEC.md` §2）。
 *
 * **並び順は `items` の配列順そのもの。** 並び順の列を別に持たない。
 * 2つあると必ずずれるし、ずれたときにどちらが正しいか決められない。
 * 表示上の番号は配列の添字 + 1（`formatItemNumber`）。
 *
 * **項目の実体は可変長。** 100個の空スロットは持たない（`PRODUCT_SPEC.md` §3）。
 * 空枠は表示のときだけ作る（`toSlots`）。
 */
export interface LocalList {
  title: string
  items: Item[]
}

/**
 * 操作の結果。**失敗を握り潰さない。**
 *
 * 上限に当たったのか、入力が不正なのか、対象が見つからないのかで
 * 画面に出すべきことが違う。`null` を返して呼び出し側に推測させない。
 *
 * 🔴 **「空」と「長すぎ」を1つの理由にまとめない**（#79 で実際に踏んだ）。
 * まとめると、長すぎて弾かれた人に「1文字以上入力してください」と出て、
 * **何を直せばいいのか分からない。**
 */
export type ListResult =
  | { ok: true; list: LocalList }
  | {
      ok: false
      reason:
        | 'text-empty'
        | 'text-too-long'
        | 'title-empty'
        | 'title-too-long'
        | 'list-full'
        | 'not-found'
    }

/**
 * Zod の失敗が「長すぎ」かを見る。**文字数の値はここに書かない**
 * （上限は `packages/shared` のスキーマが持っている）。
 */
function isTooLong(error: z.ZodError): boolean {
  return error.issues.some((issue) => issue.code === 'too_big')
}

export function createEmptyList(): LocalList {
  return { title: DEFAULT_LIST_TITLE, items: [] }
}

/**
 * 項目を末尾に足す。
 *
 * 検証は `packages/shared` の `itemTextSchema` に任せる（前後の空白は落ちる）。
 * **ここで文字数を書かない。** 上限の情報源は1箇所（`CLAUDE.md` の不変条件）。
 */
export function addItem(list: LocalList, item: { id: string; text: string }): ListResult {
  if (list.items.length >= ITEMS_PER_LIST_MAX) return { ok: false, reason: 'list-full' }

  const text = itemTextSchema.safeParse(item.text)
  if (!text.success) {
    return { ok: false, reason: isTooLong(text.error) ? 'text-too-long' : 'text-empty' }
  }

  return {
    ok: true,
    list: {
      ...list,
      items: [
        ...list.items,
        { id: item.id, text: text.data, completedAt: null, completedPrecision: null },
      ],
    },
  }
}

/** 項目の本文を変える。完了日時は触らない。 */
export function updateItemText(list: LocalList, id: string, text: string): ListResult {
  if (!list.items.some((item) => item.id === id)) return { ok: false, reason: 'not-found' }

  const parsed = itemTextSchema.safeParse(text)
  if (!parsed.success) {
    return { ok: false, reason: isTooLong(parsed.error) ? 'text-too-long' : 'text-empty' }
  }

  return { ok: true, list: mapItem(list, id, (item) => ({ ...item, text: parsed.data })) }
}

/**
 * 完了にする / 取り消す / 完了日を変える（#279）。
 *
 * `completedPrecision` に `null` を渡すと取り消し。**リスト内の位置は動かさない**
 * （`PRODUCT_SPEC.md` §4.5。番号 = 並び順が動くと、どれを完了したのか分からなくなる）。
 *
 * 🔴 **日時と粒度を必ず一緒に渡す。** 片方だけ変えられる形にすると、
 * 「粒度は `day` なのに日時が無い」という組み合わせが画面の中に作れてしまう
 * （サーバーは DB のトリガーで止めるが、画面の表示はそこまで待たない）。
 */
export function setItemCompletion(
  list: LocalList,
  id: string,
  completion: { completedAt: number | null; completedPrecision: CompletedPrecision | null },
): ListResult {
  if (!list.items.some((item) => item.id === id)) return { ok: false, reason: 'not-found' }

  return { ok: true, list: mapItem(list, id, (item) => ({ ...item, ...completion })) }
}

/**
 * 日付を覚えていない完了（#279）。**完了しているが日時を持たない。**
 *
 * ⚠️ **「やった」印を付けたときの既定ではない**（2026-08-15、#298）。
 * ✓ を押したときはその日が入る。ここに落ちるのは、
 * 完了の設定で**年を空にした**ときだけ（`changeCompletedOn(null)`）。
 */
export const COMPLETION_WITHOUT_DATE = {
  completedAt: null,
  completedPrecision: 'unknown',
} as const

/** 未完了に戻すときの値。 */
export const NOT_COMPLETED = { completedAt: null, completedPrecision: null } as const

/**
 * 断られた理由。**ローカルの検証結果とサーバーの応答を同じ形にまとめる。**
 * 画面はどちらに保存しているかを気にせず文言を出せる。
 */
export type Rejection =
  | Extract<ListResult, { ok: false }>['reason']
  | 'server-error'
  /** 並べ替えを送ったら、サーバー側の項目と食い違っていた（#142） */
  | 'order-stale'

/**
 * 断られた理由の文言。
 *
 * 🔴 **「空」と「長すぎ」を同じ文言にしない**（#79 で実際に踏んだ）。
 * 長すぎて弾かれた人に「1文字以上入力してください」と出しても、何を直せばいいのか
 * 分からない。文字数は `packages/shared` の定数から出す（ここに数字を書かない）。
 *
 * ⚠️ **画面ごとに書かない。** リストの編集と取り入れ面（#235）の両方から使う。
 * 別々に持つと、同じ理由で違う文言が出る。
 */
export function rejectionMessage(reason: Rejection): string {
  return REJECTION_MESSAGES[reason]
}

const REJECTION_MESSAGES: Record<Rejection, string> = {
  'text-empty': 'やりたいことを入力してください',
  'text-too-long': `やりたいことは${String(ITEM_TEXT_MAX_LENGTH)}文字までです`,
  'title-empty': 'タイトルを入力してください',
  'title-too-long': `タイトルは${String(LIST_TITLE_MAX_LENGTH)}文字までです`,
  'list-full': `${String(ITEMS_PER_LIST_MAX)}件まで書けます。減らすと続けて書けます`,
  'not-found': '対象の項目が見つかりませんでした',
  'server-error': '保存できませんでした。通信を確かめて、もう一度試してください',
  // 別のタブや端末で項目が増減していた。手元の並びを押し通さず、取り直している（#142）
  'order-stale': '他のところで項目が変わっていたので、最新の状態を読み直しました',
}

/**
 * 取り入れ面の並びで、**既に自分のリストにあるものを後ろへ回す**（#246）。
 *
 * 探しに来た人にとって、**もう持っているものは選択肢ではない。**
 * 消さないのは「取り入れ済み」だと分かることに意味があるため（同じものを探し続けない）。
 *
 * ⚠️ **サーバーの並びは崩さない。** 同じ組の中では受け取った順のまま
 * （`Array.prototype.sort` は安定なので、真偽値の差だけで並べれば元の順が残る）。
 *
 * ⚠️ **使うのは未ログインのときだけ**（#249 で変えた）。
 * ログイン中は**サーバーが全体を並べ替える**（取り入れ先のリスト ID を渡している）。
 * 画面側だけで並べ替えると、**1ページ目に自分の項目が固まっていたときに
 * 2ページ目の知らない項目が繰り上がってこない。**
 *
 * ⚠️ **受け取った時点で1回だけ呼ぶ**（`DiscoverPage`）。描くたびに呼ぶと、
 * 1件取り入れた瞬間にその行が下へ飛び、下にあった行が全部せり上がる。
 */
export function sortAdoptedLast<T extends { text: string }>(rows: T[], list: LocalList): T[] {
  return [...rows].sort((a, b) => Number(hasText(list, a.text)) - Number(hasText(list, b.text)))
}

/**
 * その本文が既にリストにあるか（#235）。
 *
 * 取り入れ面で「取り入れ済み」を出すための判定。**完全一致で見る。**
 * 前後の空白は `itemTextSchema` が落としているので、揺れは残らない。
 *
 * 🔴 **サーバーに聞かない。** 未ログインでも同じ判定が要る（保存先が localStorage）ので、
 * 手元のリストだけで決められる形にしてある。
 */
export function hasText(list: LocalList, text: string): boolean {
  return list.items.some((item) => item.text === text)
}

export function removeItem(list: LocalList, id: string): ListResult {
  if (!list.items.some((item) => item.id === id)) return { ok: false, reason: 'not-found' }

  return { ok: true, list: { ...list, items: list.items.filter((item) => item.id !== id) } }
}

/**
 * 項目を `toIndex` の位置へ動かす（並び替え）。
 *
 * 画面の並び替え（DnD）は MVP では省略可だが、**データは並び順前提にしておく**
 * という決定があるので、計算だけ先に置く（`PRODUCT_SPEC.md` §4.4）。
 *
 * `toIndex` は移動**後**の添字。範囲外は端に丸める（画面から来る値を信用しない）。
 */
export function moveItem(list: LocalList, id: string, toIndex: number): ListResult {
  const from = list.items.findIndex((item) => item.id === id)
  if (from === -1) return { ok: false, reason: 'not-found' }

  const moved = list.items[from]
  if (!moved) return { ok: false, reason: 'not-found' }

  const rest = list.items.filter((item) => item.id !== id)
  const to = Math.min(Math.max(Math.trunc(toIndex), 0), rest.length)

  return { ok: true, list: { ...list, items: [...rest.slice(0, to), moved, ...rest.slice(to)] } }
}

/** リストのタイトルを変える。検証は `listTitleSchema`（空文字は通らない）。 */
export function renameList(list: LocalList, title: string): ListResult {
  const parsed = listTitleSchema.safeParse(title)
  if (!parsed.success) {
    return { ok: false, reason: isTooLong(parsed.error) ? 'title-too-long' : 'title-empty' }
  }

  return { ok: true, list: { ...list, title: parsed.data } }
}

function mapItem(list: LocalList, id: string, fn: (item: Item) => Item): LocalList {
  return { ...list, items: list.items.map((item) => (item.id === id ? fn(item) : item)) }
}

// --- 表示 -------------------------------------------------------------------

/**
 * 100枠の表示用。**未入力の枠も含めて常に `ITEMS_PER_LIST_MAX` 個返す**
 * （`PRODUCT_SPEC.md` §4.1）。データ側に空スロットを作らないための変換。
 */
export interface Slot {
  number: string
  item: Item | null
}

export function toSlots(list: LocalList): Slot[] {
  return Array.from({ length: ITEMS_PER_LIST_MAX }, (_, index) => ({
    number: formatItemNumber(index + 1),
    item: list.items[index] ?? null,
  }))
}

/** 表示上の番号。`001` から始まる連番（`PRODUCT_SPEC.md` §3）。 */
export function formatItemNumber(n: number): string {
  return String(n).padStart(3, '0')
}

/**
 * 「23 / 100」の左側。**達成度ではなく埋まり具合**（`PRODUCT_SPEC.md` §3）。
 *
 * 完了した数ではない。ここを完了数にすると、埋めることの動機付けが消える。
 */
export function filledCount(list: LocalList): number {
  return list.items.length
}

/**
 * 「やった」印を付けた数（#145）。
 *
 * **埋まり具合（`filledCount`）を置き換えない。** 並べて出す。
 * 100 という枠がまだ埋まっていないことを見せるのがあちらの役目で、
 * こちらは「そのうち何個叶えたか」。**別のことを言っている。**
 *
 * **分母は書いた数**（`filledCount`）。マークダウン（#129）と同じ（2026-08-08、#168）。
 * 書いていない枠を「やっていない」と数えない、ということ。
 * 「書けた」の分母が 100 なのは、**あちらが枠の空き具合を見せる数字**だから。
 */
export function completedCount(list: LocalList): number {
  // 🔴 **粒度で数える**（#279）。`completedAt` で数えると
  // 日付なしの完了が「やった」に入らない
  return list.items.filter((item) => isCompleted(item.completedPrecision)).length
}

// --- 共有のお誘い（#276） ---------------------------------------------------

/**
 * 何をきっかけに誘うか（#276）。
 *
 * **人が貼りたくなるのは、空のリストではなく達成したとき。**
 * それまでの導線は「共有の設定を開く → 公開範囲を変える → URL をコピー」だけで、
 * **一番気分が乗っている瞬間には何も起きなかった。**
 */
export type ShareInviteTrigger =
  /** 「やった」印を1つ増やした */
  | 'completed'
  /** 100個すべて埋まった。**書き上げた瞬間で、見せるものが揃った瞬間** */
  | 'filled'

/** 誘うかどうかの判定に使う分だけの進み具合。 */
export interface ListProgress {
  completed: number
  filled: number
}

export function listProgress(list: LocalList): ListProgress {
  return { completed: completedCount(list), filled: filledCount(list) }
}

/**
 * 進み具合の変化から、誘うきっかけを決める（#276）。
 *
 * 🔴 **増えたときだけ。** 減ったとき（完了の取り消し、項目の削除）には出さない。
 * ⚠️ **100個目を消して書き直すたびに出さない**のは、ここでは止めきれない
 * （また `filled` が上限に達するため）。**間隔の方で吸収する**（`canInviteToShare`）。
 *
 * 両方が同時に起きたら `filled` を選ぶ。**100個書き上げた方が大きな節目。**
 */
export function shareInviteTrigger(
  before: ListProgress,
  after: ListProgress,
): ShareInviteTrigger | null {
  if (after.filled >= ITEMS_PER_LIST_MAX && before.filled < ITEMS_PER_LIST_MAX) return 'filled'
  if (after.completed > before.completed) return 'completed'

  return null
}

/**
 * 節目に出すお誘いの種類。**ログインしているかで次の一歩が違う。**
 *
 * | | 次の一歩 |
 * |---|---|
 * | `share` | 共有する（#276） |
 * | `sign-in` | まずログインする（#284） |
 */
export type InviteKind = 'share' | 'sign-in'

/**
 * どちらのお誘いを出すか（#284）。**出さないなら `null`。**
 *
 * 🔴 **未ログインは「書き終えたとき」だけ。**
 * 共有設定はログインの向こう側にあるので、共有へ誘っても**その場では何もできない。**
 * 一方 100個書き終えるのは一番大きな節目なので、そこは**ログインへ誘う**。
 *
 * ⚠️ 未ログインでは完了にできない（#77）ので `completed` は本来来ないが、
 * **来ても誘わない**と書いておく（完了の条件が変わったときに勝手に増えないように）。
 */
export function inviteKind(trigger: ShareInviteTrigger, shared: boolean): InviteKind | null {
  if (shared) return 'share'

  return trigger === 'filled' ? 'sign-in' : null
}

/**
 * **何が起きて出たのか**（#306）。モーダルの見出しになる。
 *
 * 🔴 **見出しで「いま自分が何をしたか」を言う**（2026-08-15 の利用者の指摘）。
 * 以前は「みんなにもリストを見せませんか？」から始まっていて、
 * **なぜ出たのか分からず、押し間違いで出た広告のように見えた。**
 * 共有を促す文は本文の先頭へ移した（文言はそのまま。#276）。
 */
export type Achievement =
  /** 1つ叶えた。**その項目の本文を持つ**（どれを達成したかを見出しで言うため） */
  | { kind: 'completed'; text: string }
  /** 100個すべて書き終えた */
  | { kind: 'filled' }

/**
 * 100個書き終えたときの見出し。
 *
 * 🔴 **未ログインのお誘い（#284）と同じ文言を使う。** 書き分けると必ずずれる
 * （利用者が書いた文をそのまま使う、という #276 / #284 の扱いも変えない）。
 */
export const WROTE_ALL_TITLE = '100個、書き終わりました！'

/**
 * モーダルの見出し（#306）。
 *
 * 🔴 **利用者が指示した形をそのまま使う**（2026-08-15）:
 * 「〈やりたいこと〉を達成しました」。言い換えない。
 */
export function achievementTitle(achievement: Achievement): string {
  return achievement.kind === 'filled' ? WROTE_ALL_TITLE : `${achievement.text}を達成しました`
}

/**
 * 直前の状態と見比べて、**新しく完了した項目の本文**を返す（#306）。
 *
 * 見出しに「どれを達成したか」を出すために要る。お誘いの判定は達成数の増減
 * （`shareInviteTrigger`）だけを見ているので、**項目はここで特定する。**
 *
 * 🔴 **`completedPrecision` で見る**（#279）。日付なしの完了も達成に入る。
 * ⚠️ **同時に2つ以上完了していたら、リストで先に来るものを返す。**
 * 1回の操作で1つしか完了できないので、実際には起きない
 * （起きるとしたら別の端末での操作が同時に届いたとき）。
 *
 * 分からなければ `null`。**呼び出し側はそのときお誘いを出さない**
 * （「なぜ出たか」を言えないなら出さない方がよい。#306）。
 */
export function newlyCompletedText(before: LocalList, after: LocalList): string | null {
  const completedBefore = new Set(
    before.items.filter((item) => isCompleted(item.completedPrecision)).map((item) => item.id),
  )

  const item = after.items.find(
    (candidate) => isCompleted(candidate.completedPrecision) && !completedBefore.has(candidate.id),
  )

  return item?.text ?? null
}

/**
 * 同じリストで続けて出さない間隔。**30日**（2026-08-14 の利用者の指示）。
 *
 * 🔴 **「1回きり」にしない。** そのとき断っただけの人を、一生誘わないのはやりすぎ。
 * ⚠️ **きっかけごとに分けない。** リスト単位で「最後に出した日」を1つ持つ。
 * 分けると、叶えた直後に100個目を書いた人に**続けて2回出る。**
 */
export const SHARE_INVITE_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * いま誘ってよいか（#276）。
 *
 * `invitedAt` は**そのリストで最後に出した時刻**。まだ一度も出していなければ `null`。
 */
export function canInviteToShare({
  invitedAt,
  now,
}: {
  invitedAt: number | null
  now: number
}): boolean {
  return invitedAt === null || now - invitedAt >= SHARE_INVITE_INTERVAL_MS
}

/**
 * 最後に誘った時刻の保存先。**読み書きそのものは `*.tsx` 側**（`LIST_STORAGE_KEY` と同じ）。
 *
 * 🔴 **リストごとに分ける。** 1つにまとめると、リストを5つ持っている人は
 * **どれか1つで断ったら全部で30日出なくなる。**
 */
export function shareInviteStorageKey(listId: string): string {
  return `yaritai100list:share-invite:v1:${listId}`
}

/** 保存されていなければ `null` を渡す（`getItem` の戻り値をそのまま）。 */
export function parseInvitedAt(raw: string | null): number | null {
  if (raw === null) return null

  const value = Number(raw)

  // 壊れていたら「出したことが無い」に倒す。**誘いを1回多く出すだけ**で害が無い
  return Number.isFinite(value) ? value : null
}

// --- 保存 -------------------------------------------------------------------

/**
 * localStorage のキー。**読み書きそのものは `*.tsx` 側**（ここに DOM を持ち込まない）。
 *
 * 末尾の `v1` は保存形式の版。形を変えるときは新しいキーにして、
 * 古いキーからの引き継ぎを明示的に書く。同じキーのまま形を変えると、
 * 既存の利用者の保存が全部「壊れている」に落ちる。
 */
export const LIST_STORAGE_KEY = 'yaritai100list:list:v1'

/**
 * 保存の読み込み結果。
 *
 * 🔴 **`broken` を `empty` に混ぜないこと。** 混ぜると、読めなかっただけの保存に
 * 空リストを上書きして**利用者の書いたものを消す。** 区別があれば、画面側は
 * 「読めなかった」と伝えて上書きを止められる。`toSessionState` と同じ考え方。
 */
export type StoredListResult =
  { status: 'empty' } | { status: 'loaded'; list: LocalList } | { status: 'broken' }

/**
 * 保存されている形。**上限（文字数・件数）はここで検査しない。**
 *
 * 検査すると、後で上限を下げたときに既存の保存が丸ごと `broken` になり、
 * 1項目のために100項目を捨てることになる。上限は「新しく入れるとき」に効かせる
 * （`addItem` / `updateItemText`）。
 */
const storedListSchema = z.object({
  title: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      completedAt: z.number().nullable(),
      /**
       * 完了日の粒度（#279）。**古い保存には無いので省略できる。**
       *
       * 必須にすると、#279 より前に書いた人の保存が丸ごと `broken` に落ちる
       * （このスキーマの注意書きのとおり、既にあるものは救う）。
       * 無いときの補い方は**マイグレーション `0016` と同じ**（日時があれば `day`）。
       */
      completedPrecision: completedPrecisionSchema.nullable().optional(),
    }),
  ),
})

export function serializeList(list: LocalList): string {
  return JSON.stringify(list)
}

/** 保存されていなければ `null` を渡す（localStorage の `getItem` の戻り値をそのまま）。 */
export function parseStoredList(raw: string | null): StoredListResult {
  if (raw === null) return { status: 'empty' }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { status: 'broken' }
  }

  const parsed = storedListSchema.safeParse(json)
  if (!parsed.success) return { status: 'broken' }

  return {
    status: 'loaded',
    list: {
      title: parsed.data.title,
      items: parsed.data.items.map((item) => ({
        ...item,
        completedPrecision: item.completedPrecision ?? (item.completedAt === null ? null : 'day'),
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// サーバーとのやりとり（#5 / #91）
// ---------------------------------------------------------------------------

/**
 * サーバーから返るリストのうち、画面が使う部分。
 *
 * **日時は文字列。** `c.json()` を通ると `Date` は ISO 文字列になるので、
 * `Date` として扱わない（`new Date(...)` を通すのはここだけにする）。
 */
export interface RemoteList {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface RemoteItem {
  id: string
  text: string
  completedAt: string | null
  /** 完了日の粒度（#279）。**`null` は未完了** */
  completedPrecision: CompletedPrecision | null
}

/**
 * トップで開くリストを選ぶ。**最後に更新したもの**（`PRODUCT_SPEC.md` §4.3）。
 *
 * リストを1つしか持っていない人に、選ぶ操作を作らないための決まり。
 * 1つも無ければ `null`（呼び出し側が作る）。
 */
export function pickCurrentListId(lists: RemoteList[]): string | null {
  let current: RemoteList | null = null

  for (const list of lists) {
    if (!current || Date.parse(list.updatedAt) > Date.parse(current.updatedAt)) {
      current = list
    }
  }

  return current?.id ?? null
}

/**
 * 一覧に出す順。**作った順**（`PRODUCT_SPEC.md` §4.3）。
 *
 * 🔴 **更新した順にしない**（#108 で直した）。更新順だと、タイトルを直したり
 * 項目を書いたりするたびに**そのリストが先頭へ飛び、どれを触ったか見失う。**
 * 「完了しても項目の位置は動かさない」（§4.5）のと同じ理由。
 *
 * トップ（`/`）が**最後に更新したリスト**を開くのは別の話
 * （あちらは1つを選ぶ基準で、並べる基準ではない）。
 *
 * 元の配列は書き換えない。React の state をそのまま渡すため。
 */
export function sortListsByCreated(lists: RemoteList[]): RemoteList[] {
  return [...lists].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/**
 * サーバーの応答を画面の形に直す。
 *
 * 項目は**サーバーが並び順で返す**ので、ここでは並べ替えない
 * （並び順の情報源を2つにしない）。
 */
export function toLocalList(list: { title: string }, items: RemoteItem[]): LocalList {
  return {
    title: list.title,
    items: items.map((item) => ({
      id: item.id,
      text: item.text,
      completedAt: item.completedAt === null ? null : Date.parse(item.completedAt),
      completedPrecision: item.completedPrecision,
    })),
  }
}

/**
 * 共有ページの URL。**組み立てはここ1箇所**（#138）。
 *
 * 画面の複数箇所で組み立てると、`/share/` を書き間違えたときに片方だけ直る。
 * オリジンを引数で受け取るのは、`window` を `model.ts` に持ち込まないため
 * （ここは workerd でテストする層。`TECH_STACK.md` §10）。
 */
export function shareUrl(origin: string, shareId: string): string {
  return `${origin}/share/${shareId}`
}

/**
 * 共有シート（`navigator.share`）が使えるか（#275）。
 *
 * 🔴 **使えない環境がある。** デスクトップの Firefox など。
 * 見て判断してから出す。**押せるのに何も起きないボタンを作らない。**
 *
 * `navigator` を引数で受け取るのは、`window` を `model.ts` に持ち込まないため
 * （`shareUrl` と同じ理由。`TECH_STACK.md` §10）。
 */
export function canUseShareSheet(target: { share?: unknown }): boolean {
  return typeof target.share === 'function'
}

/**
 * 共有シートを**閉じただけ**か（#275）。
 *
 * 🔴 **これは失敗ではない。** 開いてやめた人にエラーを見せない。
 * `navigator.share` は取り消しでも拒否されるので、区別しないと
 * **やめた人全員に「共有できませんでした」が出る。**
 */
export function isShareCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 取り込み（`POST /api/lists/import`）に送る内容。
 *
 * **完了の状態は送らない。** 未ログインでは印を付けられないので（#77）
 * ブラウザ側に完了した項目は存在せず、サーバーも受け取らない。
 */
export function toImportBody(list: LocalList): { title: string; items: { text: string }[] } {
  return { title: list.title, items: list.items.map((item) => ({ text: item.text })) }
}

/**
 * 取り込むべきものがあるか。**1項目も書いていなければ取り込まない**
 * （`PRODUCT_SPEC.md` §2）。
 *
 * サーバーでも弾いているが（`min(1)`）、**空で呼ばないのは画面側の責任**。
 * 呼んでしまうと 400 になり、「失敗した」と見える。
 */
export function hasAnythingToImport(stored: StoredListResult): boolean {
  return stored.status === 'loaded' && stored.list.items.length > 0
}

/**
 * ログインすると何ができるか（#204 / #211）。
 *
 * 🔴 **`PRODUCT_SPEC.md` §2 の「ログインの動機」と同じ数だけ並べる。**
 * 導線が3箇所にあり、それぞれ**1つの利点しか言っていなかった。**
 * その場の文言は残すが、**全部をまとめて読める場所を1つ作る。**
 *
 * ⚠️ **画面ごとに書き分けない。** 同じ内容を3箇所に書くと必ずずれる。
 * ここが唯一の定義で、`SignInBenefits.tsx` が描く。
 *
 * 🔴 **文面は利用者が書いたもの。手を入れない**（2026-08-08）。
 * 見出しも「いま／ログイン後」の対比も置かない。**そのまま読ませる。**
 *
 * 🔴 **関数にしてある。** 年を含む文言があり、**書いた時点の年で固定すると古くなる**
 * （「2026年に」が翌年も出続ける）。`now` を受け取るのはテストのため（`TECH_STACK.md` §10）。
 */
export interface SignInBenefit {
  /**
   * 目印。**文章を読む前に「何の話か」が分かるようにする**（#213）。
   *
   * ⚠️ **絵文字にしてある。** 画像を足すと初期表示が重くなり、
   * SVG を5つ書くと**この画面だけで持つ資産**が増える。
   */
  icon: string
  /** 🔴 **利用者が書いた文。手を入れない**（2026-08-08） */
  text: string
}

export function signInBenefits(now: Date): SignInBenefit[] {
  return [
    {
      // **一番効くのはこれ。** 100個書いても失う可能性があることに気付けない。
      // ⚠️ ここだけ長すぎて読み始めの負担が集まっていたので短くした（#213）
      icon: 'save',
      text: '現在のリストはこのブラウザにしかないため、履歴を消すと消えます。ログイン後はサーバーに保存され、別の端末でも編集できます。',
    },
    { icon: 'check', text: '実現した項目にチェックを付けられるようになります。' },
    {
      icon: 'lists',
      text: `現在は1つしかリストを編集できませんが、ログインをすれば「${String(now.getFullYear())}年に」「一生のうちに」のように使い分けられます。`,
    },
    {
      icon: 'link',
      text: '共有リンクを発行して、他の人にやりたいことリストを見せることができます。',
    },
    {
      icon: 'image',
      text: 'やりたいことリストの画像をダウンロードしたり、マークダウンで出力できます。SNSなどで公開できます。',
    },
  ]
}

/**
 * ログインの利点を見せるか。
 *
 * 🔴 **ログイン中には出さない。** 出すと「もうできること」を勧めることになる。
 * **`loading` と `error` でも出さない。** どちらも「未ログインだと分かっていない」状態で、
 * ログイン済みの人にログインを促してしまう（`toCompletionPermission` と同じ注意）。
 */
export function showsSignInBenefits(session: SessionState): boolean {
  return session.status === 'anonymous'
}
