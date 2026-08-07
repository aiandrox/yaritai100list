import {
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
} from '@yaritai100list/shared'
import { useState } from 'react'

import { filledCount, toSlots, type Item, type LocalList } from './model'

/**
 * リストの編集画面。**ここに置くのは描画と入力欄の下書きだけ。**
 *
 * 何が正しい値かは `model.ts` の純関数が決める（`TECH_STACK.md` §10）。
 * このファイルはテストしない。
 *
 * 変更を伝える関数は**受理されたかを真偽値で返す。** 入力欄は受理されたときだけ
 * 下書きを捨てる。捨ててから拒否されると、利用者が書いた文字が黙って消える。
 */
interface ListEditorProps {
  list: LocalList
  onRenameList: (title: string) => boolean
  onAddItem: (text: string) => boolean
  onUpdateItemText: (id: string, text: string) => boolean
  onToggleItem: (item: Item) => void
  onRemoveItem: (id: string) => void
}

export function ListEditor({
  list,
  onRenameList,
  onAddItem,
  onUpdateItemText,
  onToggleItem,
  onRemoveItem,
}: ListEditorProps) {
  const filled = filledCount(list)

  // 次に書ける枠は「埋まっている数」の位置。ここより後ろの枠は表示だけで、触れない。
  // どこにでも書けると、書いた行と入る行がずれて驚く（項目は末尾に足されるため）
  const nextIndex = filled

  return (
    <div>
      <ListTitleField title={list.title} onRename={onRenameList} />

      <p className="mt-1 flex items-baseline gap-1 text-brand-deep">
        <span className="text-2xl font-bold tabular-nums">{filled}</span>
        <span className="text-sm tabular-nums">/ {ITEMS_PER_LIST_MAX}</span>
        {/* 「達成度ではなく埋まり具合」（PRODUCT_SPEC.md §3）と分かる言葉を添える */}
        <span className="text-xs text-slate-500">書けた</span>
      </p>

      <ol className="mt-4">
        {toSlots(list).map((slot, index) =>
          slot.item ? (
            <ItemRow
              key={slot.item.id}
              number={slot.number}
              item={slot.item}
              onCommit={onUpdateItemText}
              onToggle={onToggleItem}
              onRemove={onRemoveItem}
            />
          ) : index === nextIndex ? (
            // key を固定して**同じ入力欄を使い回す**。項目を足すと1つ下へ移るが、
            // React が DOM を作り直さないのでフォーカスが外れず、続けて書ける
            <NextRow key="next" number={slot.number} onAdd={onAddItem} />
          ) : (
            <EmptyRow key={slot.number} number={slot.number} />
          ),
        )}
      </ol>
    </div>
  )
}

function ListTitleField({ title, onRename }: { title: string; onRename: (t: string) => boolean }) {
  const [draft, setDraft] = useState(title)

  const commit = () => {
    if (draft === title) return
    if (!onRename(draft)) setDraft(title) // 拒否されたら見えている値を実際の値に戻す
  }

  return (
    <input
      type="text"
      value={draft}
      aria-label="リストのタイトル"
      // 上限は shared の定数。ここに数字を書かない（CLAUDE.md の不変条件）
      maxLength={LIST_TITLE_MAX_LENGTH}
      onChange={(e) => {
        setDraft(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="w-full rounded-md bg-transparent text-xl font-bold text-slate-900 focus:bg-white focus:outline-2 focus:outline-brand-deep"
    />
  )
}

const ROW = 'flex items-center gap-2 border-b border-brand/40 py-1.5'
const NUMBER = 'w-8 shrink-0 text-right text-xs tabular-nums'
const TEXT_INPUT =
  'min-w-0 flex-1 rounded bg-transparent px-1 py-1 text-base focus:bg-white focus:outline-2 focus:outline-brand-deep'

function ItemRow({
  number,
  item,
  onCommit,
  onToggle,
  onRemove,
}: {
  number: string
  item: Item
  onCommit: (id: string, text: string) => boolean
  onToggle: (item: Item) => void
  onRemove: (id: string) => void
}) {
  const [draft, setDraft] = useState(item.text)
  const done = item.completedAt !== null

  const commit = () => {
    if (draft === item.text) return
    if (!onCommit(item.id, draft)) setDraft(item.text)
  }

  return (
    <li className={ROW}>
      <span className={`${NUMBER} ${done ? 'text-brand-deep' : 'text-slate-400'}`}>{number}</span>

      <button
        type="button"
        // 押されている状態を色だけで伝えない（読み上げと、色が見えない環境のため）
        aria-pressed={done}
        aria-label={done ? '完了を取り消す' : '完了にする'}
        onClick={() => {
          onToggle(item)
        }}
        className={`size-6 shrink-0 rounded-full border-2 text-xs leading-none ${
          done ? 'border-brand-deep bg-brand-deep text-white' : 'border-brand bg-white text-white'
        }`}
      >
        ✓
      </button>

      <input
        type="text"
        value={draft}
        aria-label={`${number} 番目のやりたいこと`}
        maxLength={ITEM_TEXT_MAX_LENGTH}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        // 完了しても**行の位置は動かさない**（PRODUCT_SPEC.md §4.5）。
        // 動くと番号と項目の対応が崩れて、どれを完了したのか分からなくなる
        className={`${TEXT_INPUT} ${done ? 'text-slate-400 line-through' : 'text-slate-900'}`}
      />

      {done && item.completedAt !== null && (
        <span className="shrink-0 text-[10px] text-brand-deep tabular-nums">
          {new Date(item.completedAt).toLocaleDateString('ja-JP')}
        </span>
      )}

      <button
        type="button"
        aria-label={`${number} 番目を削除`}
        onClick={() => {
          onRemove(item.id)
        }}
        className="shrink-0 px-1 text-sm text-slate-400"
      >
        ×
      </button>
    </li>
  )
}

function NextRow({ number, onAdd }: { number: string; onAdd: (text: string) => boolean }) {
  const [draft, setDraft] = useState('')

  const commit = () => {
    // 空白だけの入力は「書いていない」として扱う。エラーを出す場面ではない
    if (draft.trim() === '') {
      setDraft('')
      return
    }

    if (onAdd(draft)) setDraft('')
  }

  return (
    <li className={ROW}>
      <span className={`${NUMBER} text-slate-400`}>{number}</span>
      <span className="size-6 shrink-0 rounded-full border-2 border-dashed border-brand" />
      <input
        type="text"
        value={draft}
        aria-label="やりたいことを書く"
        placeholder="やりたいことを書く"
        maxLength={ITEM_TEXT_MAX_LENGTH}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          // Enter で続けて書ける。この入力欄は使い回されるのでフォーカスは外れない
          if (e.key === 'Enter') commit()
        }}
        className={`${TEXT_INPUT} text-slate-900 placeholder:text-slate-400`}
      />
    </li>
  )
}

/**
 * まだ書けない枠。**入力欄にしない**（触れると末尾に足されて行がずれる）。
 *
 * それでも描くのは、100という枠が「まだ埋まっていない」と見えることに
 * 意味があるため（`PRODUCT_SPEC.md` §1）。
 */
function EmptyRow({ number }: { number: string }) {
  return (
    <li className={`${ROW} opacity-50`} aria-hidden="true">
      <span className={`${NUMBER} text-slate-300`}>{number}</span>
      <span className="size-6 shrink-0 rounded-full border-2 border-dashed border-brand/50" />
      <span className="flex-1" />
    </li>
  )
}
