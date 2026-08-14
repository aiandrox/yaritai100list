import {
  DEFAULT_LIST_TITLE,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

import {
  addItem,
  canInviteToShare,
  canUseShareSheet,
  createEmptyList,
  inviteKind,
  isShareCancelled,
  parseInvitedAt,
  SHARE_INVITE_INTERVAL_MS,
  shareInviteStorageKey,
  shareInviteTrigger,
  completedCount,
  filledCount,
  formatItemNumber,
  showsSignInBenefits,
  signInBenefits,
  hasAnythingToImport,
  hasText,
  moveItem,
  pickCurrentListId,
  parseStoredList,
  rejectionMessage,
  removeItem,
  renameList,
  serializeList,
  shareUrl,
  sortAdoptedLast,
  sortListsByCreated,
  setItemCompletedAt,
  toCompletionPermission,
  toDateInputValue,
  toImportBody,
  toLocalList,
  toSessionState,
  toSlots,
  updateItemText,
  withDatePart,
  type ListResult,
  type LocalList,
} from '../src/client/model'

/**
 * クライアント側で**唯一テストする層**（`TECH_STACK.md` §10、#43）。
 *
 * 描画と配線（ボタンに handler が付いているか等）はテストしない。
 * ここで担保するのは「応答からログイン状態をどう決めるか」だけ。
 */
describe('toSessionState', () => {
  it('200 で本文が null なら未ログイン', () => {
    // Better Auth は未ログインでも 200 を返す。**本文で見分ける**
    expect(toSessionState({ ok: true, body: null })).toEqual({ status: 'anonymous' })
  })

  it('200 で user が入っていればログイン中', () => {
    const body = { session: { id: 's1' }, user: { id: 'u1' } }

    expect(toSessionState({ ok: true, body })).toEqual({ status: 'authenticated' })
  })

  it('🔴 HTTP が失敗なら error。未ログインにもログイン中にも倒さない', () => {
    // 500 の本文はエラーオブジェクトなので、`null` かどうかだけで判定すると
    // **ログイン中**になり、障害中にログインの導線が消える
    const body = { code: 'INTERNAL_SERVER_ERROR', message: 'boom' }

    expect(toSessionState({ ok: false, body })).toEqual({ status: 'error' })
  })

  it('200 でも想定外の形なら error', () => {
    // 応答の形が変わったときに、黙ってログイン中として扱わない
    expect(toSessionState({ ok: true, body: {} })).toEqual({ status: 'error' })
    expect(toSessionState({ ok: true, body: 'ok' })).toEqual({ status: 'error' })
    expect(toSessionState({ ok: true, body: undefined })).toEqual({ status: 'error' })
  })
})

describe('toCompletionPermission', () => {
  it('🔴 未ログインでは「やった」印を付けられない', () => {
    // 完了はログインの動機（PRODUCT_SPEC.md §2、2026-08-07 決定）
    expect(toCompletionPermission({ status: 'anonymous' })).toEqual({
      allowed: false,
      reason: 'sign-in-required',
    })
  })

  it('ログイン中なら付けられる', () => {
    expect(toCompletionPermission({ status: 'authenticated' })).toEqual({ allowed: true })
  })

  it('🔴 ログイン状態を確認できないときは付けられない。できる方に倒さない', () => {
    // 倒すと、ログインしていない人の完了がブラウザに残る
    expect(toCompletionPermission({ status: 'error' })).toEqual({
      allowed: false,
      reason: 'session-unknown',
    })
  })

  it('🔴 確認中と未ログインで理由を分ける', () => {
    // 同じ理由にすると、確認中のログイン済みの利用者にログインを促してしまう
    expect(toCompletionPermission({ status: 'loading' })).toEqual({
      allowed: false,
      reason: 'session-loading',
    })
  })
})

/**
 * 失敗すると分かっている操作でも `ok: true` を仮定して書きたくなるので、
 * **成功を主張してから中身を見る**ヘルパを通す。
 * 失敗していたら理由付きで落ちるので、原因が分かる。
 */
function expectOk(result: ListResult): LocalList {
  if (!result.ok) throw new Error(`失敗した: ${result.reason}`)

  return result.list
}

/** テスト用のリストを作る。ID は `i1`, `i2`, ... と決め打ちにして結果を固定する。 */
function listOf(...texts: string[]): LocalList {
  return texts.reduce(
    (list, text, index) => expectOk(addItem(list, { id: `i${String(index + 1)}`, text })),
    createEmptyList(),
  )
}

describe('createEmptyList', () => {
  it('既定のタイトルを持ち、項目は空', () => {
    // 100個の空スロットを持たない（PRODUCT_SPEC.md §3）
    expect(createEmptyList()).toEqual({ title: DEFAULT_LIST_TITLE, items: [] })
  })
})

describe('addItem', () => {
  it('末尾に足す。完了日時は null で始まる', () => {
    const list = expectOk(addItem(createEmptyList(), { id: 'i1', text: '南極に行く' }))

    expect(list.items).toEqual([{ id: 'i1', text: '南極に行く', completedAt: null }])
  })

  it('元のリストを書き換えない', () => {
    // React の state をそのまま渡すので、破壊的に変えると再描画が起きない
    const before = createEmptyList()
    addItem(before, { id: 'i1', text: '南極に行く' })

    expect(before.items).toEqual([])
  })

  it('前後の空白は落ちる（shared の itemTextSchema がそうしている）', () => {
    const list = expectOk(addItem(createEmptyList(), { id: 'i1', text: '  南極に行く  ' }))

    expect(list.items[0]?.text).toBe('南極に行く')
  })

  it('空文字と空白だけは通らない', () => {
    expect(addItem(createEmptyList(), { id: 'i1', text: '' })).toEqual({
      ok: false,
      reason: 'text-empty',
    })
    expect(addItem(createEmptyList(), { id: 'i1', text: '   ' })).toEqual({
      ok: false,
      reason: 'text-empty',
    })
  })

  it('🔴 上限の文字数は shared のスキーマで決まる。画面側に別の上限を書いていない', () => {
    const justFits = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH)
    const tooLong = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1)

    expect(expectOk(addItem(createEmptyList(), { id: 'i1', text: justFits })).items).toHaveLength(1)
    expect(addItem(createEmptyList(), { id: 'i1', text: tooLong })).toEqual({
      ok: false,
      reason: 'text-too-long',
    })
  })

  it('🔴 「空」と「長すぎ」で理由を分ける', () => {
    // 同じ理由にすると、長すぎて弾かれた人に「入力してください」と出て、
    // 何を直せばいいのか分からない（#79 で実際に踏んだ）
    const tooLong = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1)

    expect(addItem(createEmptyList(), { id: 'i1', text: '' })).toEqual({
      ok: false,
      reason: 'text-empty',
    })
    expect(addItem(createEmptyList(), { id: 'i1', text: tooLong })).toEqual({
      ok: false,
      reason: 'text-too-long',
    })
  })

  it('🔴 100件を超えて足せない', () => {
    const full = listOf(
      ...Array.from({ length: ITEMS_PER_LIST_MAX }, (_, i) => `やりたい${String(i)}`),
    )

    expect(addItem(full, { id: 'over', text: 'あふれる' })).toEqual({
      ok: false,
      reason: 'list-full',
    })
  })
})

describe('updateItemText', () => {
  it('本文だけ変える。完了日時は残る', () => {
    const completed = expectOk(setItemCompletedAt(listOf('南極に行く'), 'i1', 1_700_000_000_000))
    const list = expectOk(updateItemText(completed, 'i1', '北極に行く'))

    expect(list.items[0]).toEqual({
      id: 'i1',
      text: '北極に行く',
      completedAt: 1_700_000_000_000,
    })
  })

  it('検証は追加のときと同じ。空にも、長すぎにもできない', () => {
    expect(updateItemText(listOf('南極に行く'), 'i1', '  ')).toEqual({
      ok: false,
      reason: 'text-empty',
    })
    expect(
      updateItemText(listOf('南極に行く'), 'i1', 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1)),
    ).toEqual({ ok: false, reason: 'text-too-long' })
  })

  it('無い ID なら not-found。入力の不正と区別する', () => {
    // 消した項目の入力欄から遅れて届いた変更を、検証エラーとして見せない
    expect(updateItemText(listOf('南極に行く'), 'nope', '北極に行く')).toEqual({
      ok: false,
      reason: 'not-found',
    })
  })
})

describe('setItemCompletedAt', () => {
  it('完了日時を入れる。真偽値にしない（いつ叶えたかを残す）', () => {
    const list = expectOk(setItemCompletedAt(listOf('南極に行く'), 'i1', 1_700_000_000_000))

    expect(list.items[0]?.completedAt).toBe(1_700_000_000_000)
  })

  it('null を渡すと完了の取り消し', () => {
    const completed = expectOk(setItemCompletedAt(listOf('南極に行く'), 'i1', 1_700_000_000_000))

    expect(expectOk(setItemCompletedAt(completed, 'i1', null)).items[0]?.completedAt).toBeNull()
  })

  it('🔴 完了してもリスト内の位置は動かない', () => {
    // 番号 = 並び順なので、動くとどれを完了したのか分からなくなる（PRODUCT_SPEC.md §4.5）
    const list = expectOk(setItemCompletedAt(listOf('1つ目', '2つ目', '3つ目'), 'i2', 1))

    expect(list.items.map((item) => item.id)).toEqual(['i1', 'i2', 'i3'])
  })

  it('無い ID なら not-found', () => {
    expect(setItemCompletedAt(listOf('南極に行く'), 'nope', 1)).toEqual({
      ok: false,
      reason: 'not-found',
    })
  })
})

/**
 * 完了日の直し（#207）。
 *
 * 🔴 どちらも**端末の時間帯で**動く。UTC で計算すると、
 * 日本時間の朝9時より前に完了した項目が1日ずれる。
 * テストの実行環境の時間帯に依存しないよう、**入れた値と出た値の関係**だけを見る。
 */
describe('toDateInputValue / withDatePart', () => {
  /** その端末の時間帯での 2026-05-03 12:34。 */
  const noon = new Date(2026, 4, 3, 12, 34, 56, 789).getTime()

  describe('toDateInputValue', () => {
    it('YYYY-MM-DD にする', () => {
      expect(toDateInputValue(noon)).toBe('2026-05-03')
    })

    it('1桁の月日を0で埋める', () => {
      expect(toDateInputValue(new Date(2026, 0, 9, 12).getTime())).toBe('2026-01-09')
    })

    it('🔴 端末の時間帯で見た日付になる（UTC の日付ではない）', () => {
      // toISOString().slice(0, 10) だと、時間帯によっては前日／翌日になる
      const midnight = new Date(2026, 4, 3, 0, 30).getTime()
      const lateNight = new Date(2026, 4, 3, 23, 30).getTime()

      expect(toDateInputValue(midnight)).toBe('2026-05-03')
      expect(toDateInputValue(lateNight)).toBe('2026-05-03')
    })
  })

  describe('withDatePart', () => {
    it('日付だけ変わる', () => {
      const next = withDatePart(noon, '2020-01-15')

      expect(next).not.toBeNull()
      expect(toDateInputValue(next ?? 0)).toBe('2020-01-15')
    })

    it('🔴 時刻は元のまま（その日の 00:00 にしない）', () => {
      // 00:00 にすると、共有ページ（Asia/Tokyo 固定）で前日に見えることがある
      const changed = new Date(withDatePart(noon, '2020-01-15') ?? 0)

      expect([changed.getHours(), changed.getMinutes(), changed.getSeconds()]).toEqual([12, 34, 56])
    })

    it('入れた日付がそのまま読み戻せる（往復して動かない）', () => {
      for (const date of ['2026-01-01', '2026-02-28', '2026-12-31', '2024-02-29']) {
        expect(toDateInputValue(withDatePart(noon, date) ?? 0)).toBe(date)
      }
    })

    it('🔴 存在しない日は null（黙って別の日にしない）', () => {
      // setFullYear は 2026-02-30 を 3月2日に繰り上げる
      expect(withDatePart(noon, '2026-02-30')).toBeNull()
      expect(withDatePart(noon, '2026-13-01')).toBeNull()
    })

    it('🔴 読めない値は null（画面から来る値を信用しない）', () => {
      for (const bad of ['', '2026-5-3', '2026/05/03', 'あした', '2026-05-03T00:00:00Z']) {
        expect(withDatePart(noon, bad)).toBeNull()
      }
    })
  })
})

describe('removeItem', () => {
  it('消すと後ろが詰まる（番号は並び順なので振り直される）', () => {
    const list = expectOk(removeItem(listOf('1つ目', '2つ目', '3つ目'), 'i2'))

    expect(list.items.map((item) => item.id)).toEqual(['i1', 'i3'])
  })

  it('無い ID なら not-found。黙って成功にしない', () => {
    expect(removeItem(listOf('南極に行く'), 'nope')).toEqual({ ok: false, reason: 'not-found' })
  })
})

describe('moveItem', () => {
  it('指定した位置へ動かす（toIndex は移動後の添字）', () => {
    const list = expectOk(moveItem(listOf('1つ目', '2つ目', '3つ目'), 'i1', 2))

    expect(list.items.map((item) => item.id)).toEqual(['i2', 'i3', 'i1'])
  })

  it('後ろから前へも動く', () => {
    const list = expectOk(moveItem(listOf('1つ目', '2つ目', '3つ目'), 'i3', 0))

    expect(list.items.map((item) => item.id)).toEqual(['i3', 'i1', 'i2'])
  })

  it('範囲外の位置は端に丸める。画面から来る値を信用しない', () => {
    const list = listOf('1つ目', '2つ目', '3つ目')

    expect(expectOk(moveItem(list, 'i1', 99)).items.map((i) => i.id)).toEqual(['i2', 'i3', 'i1'])
    expect(expectOk(moveItem(list, 'i3', -5)).items.map((i) => i.id)).toEqual(['i3', 'i1', 'i2'])
  })

  it('無い ID なら not-found', () => {
    expect(moveItem(listOf('南極に行く'), 'nope', 0)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('🔴 完了の状態は動かしても変わらない', () => {
    const done = expectOk(setItemCompletedAt(listOf('1つ目', '2つ目'), 'i1', 1_700_000_000_000))
    const list = expectOk(moveItem(done, 'i1', 1))

    expect(list.items[1]?.completedAt).toBe(1_700_000_000_000)
  })

  it('1件だけでも壊れない', () => {
    const list = listOf('1つ目')

    expect(expectOk(moveItem(list, 'i1', 0)).items.map((i) => i.id)).toEqual(['i1'])
    expect(expectOk(moveItem(list, 'i1', 5)).items.map((i) => i.id)).toEqual(['i1'])
  })
})

describe('renameList', () => {
  it('タイトルを変える', () => {
    expect(expectOk(renameList(createEmptyList(), '2026年の目標')).title).toBe('2026年の目標')
  })

  it('🔴 上限は shared の listTitleSchema で決まる', () => {
    const tooLong = 'あ'.repeat(LIST_TITLE_MAX_LENGTH + 1)

    expect(renameList(createEmptyList(), tooLong)).toEqual({
      ok: false,
      reason: 'title-too-long',
    })
  })

  it('空にはできない', () => {
    expect(renameList(createEmptyList(), '  ')).toEqual({ ok: false, reason: 'title-empty' })
  })

  it('既定のタイトルは上限に収まっている', () => {
    // DEFAULT_LIST_TITLE は12文字で上限15。上限を下げるとここが先に落ちる
    expect(expectOk(renameList(createEmptyList(), DEFAULT_LIST_TITLE)).title).toBe(
      DEFAULT_LIST_TITLE,
    )
  })
})

describe('toSlots / formatItemNumber / filledCount', () => {
  it('未入力の枠も含めて常に100枠返す', () => {
    expect(toSlots(listOf('南極に行く'))).toHaveLength(ITEMS_PER_LIST_MAX)
  })

  it('入っている枠には項目が、残りには null が入る', () => {
    const slots = toSlots(listOf('南極に行く'))

    expect(slots[0]).toEqual({
      number: '001',
      item: { id: 'i1', text: '南極に行く', completedAt: null },
    })
    expect(slots[1]).toEqual({ number: '002', item: null })
  })

  it('番号は 001 から始まる3桁', () => {
    expect(formatItemNumber(1)).toBe('001')
    expect(formatItemNumber(23)).toBe('023')
    expect(formatItemNumber(100)).toBe('100')
  })

  it('🔴 達成済みの数を数える', () => {
    const one = expectOk(setItemCompletedAt(listOf('1つ目', '2つ目', '3つ目'), 'i1', 1))
    const two = expectOk(setItemCompletedAt(one, 'i3', 1))

    expect(completedCount(createEmptyList())).toBe(0)
    expect(completedCount(listOf('1つ目', '2つ目'))).toBe(0)
    expect(completedCount(one)).toBe(1)
    expect(completedCount(two)).toBe(2)
  })

  it('🔴 全部やっても、埋まり具合とは別の数字のまま', () => {
    // 置き換えると「100 という枠がまだ埋まっていない」が見えなくなる（#145）
    const all = ['1つ目', '2つ目'].reduce(
      (list, _, index) => expectOk(setItemCompletedAt(list, `i${String(index + 1)}`, 1)),
      listOf('1つ目', '2つ目'),
    )

    expect(completedCount(all)).toBe(2)
    expect(filledCount(all)).toBe(2)
  })

  it('🔴 「23 / 100」の左は埋まり具合。完了した数ではない', () => {
    const list = expectOk(setItemCompletedAt(listOf('1つ目', '2つ目', '3つ目'), 'i1', 1))

    expect(filledCount(list)).toBe(3)
  })
})

describe('pickCurrentListId', () => {
  it('🔴 最後に更新したリストを選ぶ', () => {
    // リストを1つしか持っていない人に選ぶ操作を作らないための決まり（PRODUCT_SPEC.md §4.3）
    const id = pickCurrentListId([
      { id: 'old', title: 'a', createdAt: 'x', updatedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'newest', title: 'b', createdAt: 'x', updatedAt: '2026-08-07T00:00:00.000Z' },
      { id: 'middle', title: 'c', createdAt: 'x', updatedAt: '2026-08-05T00:00:00.000Z' },
    ])

    expect(id).toBe('newest')
  })

  it('1つも無ければ null（呼び出し側が作る）', () => {
    expect(pickCurrentListId([])).toBeNull()
  })
})

describe('shareUrl', () => {
  it('共有ページの URL を組み立てる', () => {
    expect(shareUrl('https://example.com', 'abc123')).toBe('https://example.com/share/abc123')
  })

  it('組み立ては1箇所（画面で書き分けない）', () => {
    // 複数箇所で組み立てると、/share/ を書き間違えたときに片方だけ直る
    expect(shareUrl('http://localhost:5173', 'x')).toContain('/share/')
  })
})

/**
 * 共有シート（#275）。
 *
 * **押せるのに何も起きないボタンを作らない**ためと、
 * **やめた人にエラーを見せない**ため。どちらも見た目ではなく判断なので、ここで固定できる。
 */
describe('canUseShareSheet', () => {
  it('使える環境では true', () => {
    expect(canUseShareSheet({ share: () => Promise.resolve() })).toBe(true)
  })

  it('🔴 無い環境では false（ボタンを出さない）', () => {
    expect(canUseShareSheet({})).toBe(false)
  })

  it('🔴 関数でないものが入っていても false', () => {
    // 「鍵があるか」で見ると、別物が入っている環境で押せるボタンが出る
    expect(canUseShareSheet({ share: true })).toBe(false)
  })
})

/**
 * 共有のお誘い（#276）。
 *
 * **うるさくしないための判断**なので、ここで固定しておく。
 * 出す条件を間違えると「叶えるたびに毎回出る」になり、一番やってはいけない。
 */
describe('shareInviteTrigger', () => {
  const at = (completed: number, filled: number) => ({ completed, filled })

  it('「やった」が増えたら誘う', () => {
    expect(shareInviteTrigger(at(0, 3), at(1, 3))).toBe('completed')
  })

  it('100個そろったら誘う', () => {
    expect(shareInviteTrigger(at(0, 99), at(0, 100))).toBe('filled')
  })

  it('🔴 100個そろうまでは誘わない', () => {
    expect(shareInviteTrigger(at(0, 98), at(0, 99))).toBeNull()
  })

  it('🔴 完了を取り消したときは誘わない', () => {
    expect(shareInviteTrigger(at(1, 3), at(0, 3))).toBeNull()
  })

  it('🔴 項目を消したときは誘わない', () => {
    expect(shareInviteTrigger(at(0, 100), at(0, 99))).toBeNull()
  })

  it('🔴 100個のまま完了を付けても、また誘いにはなる（きっかけが違う）', () => {
    // 埋まったのは前のことなので `filled` ではなく `completed`
    expect(shareInviteTrigger(at(0, 100), at(1, 100))).toBe('completed')
  })

  it('同時に起きたら「書き終えた」を選ぶ（大きい節目）', () => {
    expect(shareInviteTrigger(at(0, 99), at(1, 100))).toBe('filled')
  })

  it('何も変わっていなければ誘わない', () => {
    expect(shareInviteTrigger(at(2, 50), at(2, 50))).toBeNull()
  })
})

describe('inviteKind', () => {
  it('ログイン中は共有へ誘う', () => {
    expect(inviteKind('completed', true)).toBe('share')
    expect(inviteKind('filled', true)).toBe('share')
  })

  it('🔴 未ログインで書き終えたら、共有ではなくログインへ誘う', () => {
    // 共有設定はログインの向こう側にあるので、共有へ送っても何もできない
    expect(inviteKind('filled', false)).toBe('sign-in')
  })

  it('🔴 未ログインで「やった」が増えても誘わない', () => {
    // そもそも未ログインでは完了にできない（#77）。条件が変わっても勝手に増えないように
    expect(inviteKind('completed', false)).toBeNull()
  })
})

describe('canInviteToShare', () => {
  const now = Date.parse('2026-08-14T00:00:00.000Z')

  it('一度も出していなければ出す', () => {
    expect(canInviteToShare({ invitedAt: null, now })).toBe(true)
  })

  it('🔴 直後には出さない（続けて2回出さない）', () => {
    expect(canInviteToShare({ invitedAt: now - 1000, now })).toBe(false)
  })

  it('🔴 30日経っていれば、同じリストでもまた出す', () => {
    expect(canInviteToShare({ invitedAt: now - SHARE_INVITE_INTERVAL_MS, now })).toBe(true)
  })

  it('29日目はまだ出さない', () => {
    expect(canInviteToShare({ invitedAt: now - 29 * 24 * 60 * 60 * 1000, now })).toBe(false)
  })
})

describe('shareInviteStorageKey / parseInvitedAt', () => {
  it('🔴 リストごとに別のキー（1つ断っても他のリストに響かない）', () => {
    expect(shareInviteStorageKey('a')).not.toBe(shareInviteStorageKey('b'))
  })

  it('保存されていなければ null', () => {
    expect(parseInvitedAt(null)).toBeNull()
  })

  it('壊れていたら「出したことが無い」に倒す', () => {
    // 誘いが1回多く出るだけで害が無い。読めないことを理由に永久に出さない方が困る
    expect(parseInvitedAt('こわれている')).toBeNull()
  })

  it('保存した値を読み戻せる', () => {
    const now = Date.now()

    expect(parseInvitedAt(String(now))).toBe(now)
  })
})

describe('isShareCancelled', () => {
  it('🔴 閉じただけ（AbortError）は失敗ではない', () => {
    const aborted = new Error('canceled')
    aborted.name = 'AbortError'

    expect(isShareCancelled(aborted)).toBe(true)
  })

  it('ほかの失敗は失敗として扱う', () => {
    expect(isShareCancelled(new Error('NotAllowedError'))).toBe(false)
  })

  it('Error でないものが飛んできても落ちない', () => {
    expect(isShareCancelled('AbortError')).toBe(false)
    expect(isShareCancelled(undefined)).toBe(false)
  })
})

describe('sortListsByCreated', () => {
  const lists = [
    { id: 'second', title: 'a', createdAt: '2026-08-05T00:00:00.000Z', updatedAt: 'x' },
    { id: 'first', title: 'b', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: 'x' },
    { id: 'third', title: 'c', createdAt: '2026-08-07T00:00:00.000Z', updatedAt: 'x' },
  ]

  it('作った順に並ぶ', () => {
    expect(sortListsByCreated(lists).map((list) => list.id)).toEqual(['first', 'second', 'third'])
  })

  it('🔴 更新しても並びが変わらない', () => {
    // 更新順だと、タイトルを直すたびにそのリストが先頭へ飛び、
    // どれを触ったか見失う（#108 で直した）
    const edited = lists.map((list) =>
      list.id === 'first' ? { ...list, updatedAt: '2099-01-01T00:00:00.000Z' } : list,
    )

    expect(sortListsByCreated(edited).map((list) => list.id)).toEqual(['first', 'second', 'third'])
  })

  it('元の配列を書き換えない', () => {
    // React の state をそのまま渡すので、破壊的に並べ替えると再描画が起きない
    sortListsByCreated(lists)

    expect(lists.map((list) => list.id)).toEqual(['second', 'first', 'third'])
  })
})

describe('toLocalList', () => {
  it('サーバーの応答を画面の形に直す。完了日時は数値になる', () => {
    const list = toLocalList({ title: '2026年の目標' }, [
      { id: 'i1', text: '南極に行く', completedAt: '2026-08-07T00:00:00.000Z' },
      { id: 'i2', text: 'オーロラを見る', completedAt: null },
    ])

    expect(list).toEqual({
      title: '2026年の目標',
      items: [
        { id: 'i1', text: '南極に行く', completedAt: Date.parse('2026-08-07T00:00:00.000Z') },
        { id: 'i2', text: 'オーロラを見る', completedAt: null },
      ],
    })
  })

  it('🔴 並べ替えない（並び順の情報源をサーバーに1本化する）', () => {
    const list = toLocalList({ title: 'x' }, [
      { id: 'i2', text: '2番目に入っている', completedAt: null },
      { id: 'i1', text: '1番目に入っている', completedAt: null },
    ])

    expect(list.items.map((item) => item.id)).toEqual(['i2', 'i1'])
  })
})

describe('toImportBody / hasAnythingToImport', () => {
  it('本文だけを送る', () => {
    const list = listOf('南極に行く', 'オーロラを見る')

    expect(toImportBody(list)).toEqual({
      title: DEFAULT_LIST_TITLE,
      items: [{ text: '南極に行く' }, { text: 'オーロラを見る' }],
    })
  })

  it('🔴 完了の状態を送らない（未ログインでは印を付けられないため）', () => {
    const completed = expectOk(setItemCompletedAt(listOf('南極に行く'), 'i1', 1_700_000_000_000))

    // 送る口を作ると #77 の制約を迂回できてしまう
    expect(toImportBody(completed).items).toEqual([{ text: '南極に行く' }])
  })

  it('🔴 1項目も無ければ取り込まない', () => {
    expect(hasAnythingToImport({ status: 'loaded', list: createEmptyList() })).toBe(false)
    expect(hasAnythingToImport({ status: 'empty' })).toBe(false)
    expect(hasAnythingToImport({ status: 'broken' })).toBe(false)
  })

  it('1項目でもあれば取り込む', () => {
    expect(hasAnythingToImport({ status: 'loaded', list: listOf('南極に行く') })).toBe(true)
  })
})

describe('serializeList / parseStoredList', () => {
  it('直列化して読み戻すと同じリストになる', () => {
    const list = expectOk(
      setItemCompletedAt(listOf('南極に行く', 'オーロラを見る'), 'i1', 1_700_000_000_000),
    )

    expect(parseStoredList(serializeList(list))).toEqual({ status: 'loaded', list })
  })

  it('保存が無ければ empty（初回訪問）', () => {
    // localStorage.getItem は未保存で null を返す。それをそのまま渡す
    expect(parseStoredList(null)).toEqual({ status: 'empty' })
  })

  it('🔴 壊れた JSON は broken。empty に混ぜない', () => {
    // empty に倒すと、読めなかっただけの保存に空リストを上書きして書いたものを消す
    expect(parseStoredList('{壊れている')).toEqual({ status: 'broken' })
    expect(parseStoredList('')).toEqual({ status: 'broken' })
  })

  it('🔴 JSON として読めても形が違えば broken', () => {
    expect(parseStoredList('null')).toEqual({ status: 'broken' })
    expect(parseStoredList('[]')).toEqual({ status: 'broken' })
    expect(parseStoredList('{"title":"あ"}')).toEqual({ status: 'broken' })
    expect(parseStoredList('{"title":"あ","items":[{"id":"i1"}]}')).toEqual({ status: 'broken' })
    // completedAt は「未完了なら null」。キーごと無いのは想定外の形
    expect(parseStoredList('{"title":"あ","items":[{"id":"i1","text":"x"}]}')).toEqual({
      status: 'broken',
    })
  })

  it('保存された値の文字数は検査しない。1項目のために全部を捨てない', () => {
    // 上限を下げたときに、既存の保存が丸ごと broken になるのを避けている。
    // 上限は「新しく入れるとき」に効かせる（addItem / updateItemText）
    const tooLong = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1)
    const raw = JSON.stringify({
      title: DEFAULT_LIST_TITLE,
      items: [{ id: 'i1', text: tooLong, completedAt: null }],
    })

    expect(parseStoredList(raw)).toMatchObject({ status: 'loaded' })
  })
})

describe('signInBenefits / showsSignInBenefits', () => {
  const NOW = new Date('2026-08-08T00:00:00.000Z')

  it('🔴 ログイン中には出さない', () => {
    // 出すと「もうできること」を勧めることになる
    expect(showsSignInBenefits({ status: 'authenticated' })).toBe(false)
  })

  it('🔴 状態が分からないときも出さない', () => {
    // ログイン済みの人にログインを促してしまう（toCompletionPermission と同じ注意）
    expect(showsSignInBenefits({ status: 'loading' })).toBe(false)
    expect(showsSignInBenefits({ status: 'error' })).toBe(false)
  })

  it('未ログインのときだけ出す', () => {
    expect(showsSignInBenefits({ status: 'anonymous' })).toBe(true)
  })

  it('🔴 PRODUCT_SPEC.md §2 の動機を全部載せている', () => {
    // 導線が3箇所にあり、それぞれ1つの利点しか言っていなかった（#204）。
    // **1つでも欠けると、その利点はどこからも読めない**
    const text = signInBenefits(NOW)
      .map((benefit) => benefit.text)
      .join('\n')

    expect(text).toContain('履歴を消すと消えます')
    expect(text).toContain('チェックを付けられる')
    expect(text).toContain('一生のうちに')
    expect(text).toContain('共有リンク')
    expect(text).toContain('画像をダウンロード')
    expect(signInBenefits(NOW)).toHaveLength(5)
  })

  it('🔴 目印がすべての項目に付いていて、重なっていない', () => {
    // 文だけを縦に並べると、どこからどこまでが1つの話か分からない（#213）。
    // 同じ目印が2つあると、区切りとして働かない
    const icons = signInBenefits(NOW).map((benefit) => benefit.icon)

    expect(new Set(icons).size).toBe(icons.length)
  })

  it('🔴 一番上の文が長すぎない（読み始めの負担を集めない）', () => {
    // ここだけ他の倍以上あって「文字ばっかり」に見えていた（#213）
    expect(signInBenefits(NOW)[0]?.text.length).toBeLessThan(80)
  })

  it('書き出しは画像とマークダウンの両方に触れている', () => {
    const text = signInBenefits(NOW)
      .map((benefit) => benefit.text)
      .join('\n')

    expect(text).toContain('マークダウン')
  })

  it('🔴 一番上は「消える」話（一番効くので先に言う）', () => {
    expect(signInBenefits(NOW)[0]?.text).toContain('履歴を消すと消えます')
  })

  it('🔴 年は固定しない（翌年に古くならない）', () => {
    // 「2026年に」と書き込むと、翌年もそのまま出続ける
    const text = (now: Date) =>
      signInBenefits(now)
        .map((benefit) => benefit.text)
        .join('\n')

    expect(text(NOW)).toContain('2026年に')
    expect(text(new Date('2031-01-01T00:00:00.000Z'))).toContain('2031年に')
  })
})

describe('hasText', () => {
  const list = listOf('南極に行く', 'オーロラを見る')

  it('あれば true', () => {
    expect(hasText(list, '南極に行く')).toBe(true)
  })

  it('無ければ false', () => {
    expect(hasText(list, '北極に行く')).toBe(false)
  })

  it('🔴 完全一致で見る（部分一致で「ある」ことにしない）', () => {
    // 「南極に行く」を持っている人に「南極に行く準備をする」を取り入れ済みと出さない
    expect(hasText(list, '南極')).toBe(false)
    expect(hasText(list, '南極に行く準備をする')).toBe(false)
  })

  it('1件も無いリストでも落ちない', () => {
    expect(hasText(createEmptyList(), '南極に行く')).toBe(false)
  })
})

describe('rejectionMessage', () => {
  it('🔴 「空」と「長すぎ」で違う文言になる', () => {
    // 長すぎて弾かれた人に「1文字以上入力してください」と出しても直せない（#79）
    expect(rejectionMessage('text-empty')).not.toBe(rejectionMessage('text-too-long'))
  })

  it('🔴 文字数の上限を文言に埋め込まない（shared の定数から出す）', () => {
    expect(rejectionMessage('text-too-long')).toContain(String(ITEM_TEXT_MAX_LENGTH))
    expect(rejectionMessage('list-full')).toContain(String(ITEMS_PER_LIST_MAX))
  })

  it('どの理由にも文言がある', () => {
    const reasons = [
      'text-empty',
      'text-too-long',
      'title-empty',
      'title-too-long',
      'list-full',
      'not-found',
      'server-error',
      'order-stale',
    ] as const

    for (const reason of reasons) expect(rejectionMessage(reason)).not.toBe('')
  })
})

/**
 * ⚠️ **これは未ログインのときだけ使う**（#249）。
 * ログイン中の並べ替えはサーバー側（`discover-api.test.ts`）。
 */
describe('sortAdoptedLast', () => {
  const list = listOf('B', 'D')

  /** プールの行（`/api/discover` が返す形）。並べ替えの対象は本文だけ。 */
  const rows = (...texts: string[]) => texts.map((text) => ({ text, adopted: false }))

  const sorted = (...texts: string[]) => sortAdoptedLast(rows(...texts), list).map((r) => r.text)

  it('🔴 既に持っているものが後ろへ回る', () => {
    expect(sorted('A', 'B', 'C', 'D')).toEqual(['A', 'C', 'B', 'D'])
  })

  it('🔴 それぞれの組の中では受け取った順のまま（サーバーの並びを崩さない）', () => {
    // 人気順で来ているので、持っていないもの同士の順を入れ替えてはいけない
    expect(sorted('C', 'A', 'D', 'B')).toEqual(['C', 'A', 'D', 'B'])
  })

  it('全部持っていても落ちない', () => {
    expect(sorted('B', 'D')).toEqual(['B', 'D'])
  })

  it('1つも持っていなければそのまま', () => {
    expect(sortAdoptedLast(rows('A', 'C'), createEmptyList()).map((r) => r.text)).toEqual([
      'A',
      'C',
    ])
  })

  it('🔴 渡された配列を書き換えない（React の state をそのまま渡すため）', () => {
    const original = rows('A', 'B', 'C')
    sortAdoptedLast(original, list)

    expect(original.map((r) => r.text)).toEqual(['A', 'B', 'C'])
  })
})
