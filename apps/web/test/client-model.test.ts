import {
  DEFAULT_LIST_TITLE,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

import {
  addItem,
  createEmptyList,
  filledCount,
  formatItemNumber,
  moveItem,
  parseStoredList,
  removeItem,
  renameList,
  serializeList,
  setItemCompletedAt,
  toSessionState,
  toSlots,
  updateItemText,
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
      reason: 'invalid-text',
    })
    expect(addItem(createEmptyList(), { id: 'i1', text: '   ' })).toEqual({
      ok: false,
      reason: 'invalid-text',
    })
  })

  it('🔴 上限の文字数は shared のスキーマで決まる。画面側に別の上限を書いていない', () => {
    const justFits = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH)
    const tooLong = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1)

    expect(expectOk(addItem(createEmptyList(), { id: 'i1', text: justFits })).items).toHaveLength(1)
    expect(addItem(createEmptyList(), { id: 'i1', text: tooLong })).toEqual({
      ok: false,
      reason: 'invalid-text',
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

  it('検証は追加のときと同じ。空にはできない', () => {
    expect(updateItemText(listOf('南極に行く'), 'i1', '  ')).toEqual({
      ok: false,
      reason: 'invalid-text',
    })
  })

  it('無い ID なら not-found。invalid-text と区別する', () => {
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
})

describe('renameList', () => {
  it('タイトルを変える', () => {
    expect(expectOk(renameList(createEmptyList(), '2026年の目標')).title).toBe('2026年の目標')
  })

  it('🔴 上限は shared の listTitleSchema で決まる', () => {
    const tooLong = 'あ'.repeat(LIST_TITLE_MAX_LENGTH + 1)

    expect(renameList(createEmptyList(), tooLong)).toEqual({ ok: false, reason: 'invalid-title' })
  })

  it('空にはできない', () => {
    expect(renameList(createEmptyList(), '  ')).toEqual({ ok: false, reason: 'invalid-title' })
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

  it('🔴 「23 / 100」の左は埋まり具合。完了した数ではない', () => {
    const list = expectOk(setItemCompletedAt(listOf('1つ目', '2つ目', '3つ目'), 'i1', 1))

    expect(filledCount(list)).toBe(3)
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
