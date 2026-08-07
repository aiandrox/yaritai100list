import {
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
} from '@yaritai100list/shared'
import { useEffect, useState } from 'react'

import { filledCount, toSlots, type CompletionPermission, type Item, type LocalList } from './model'

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
  /** 「やった」印を付けられるか。判定は `model.ts` の `toCompletionPermission`。 */
  completion: CompletionPermission
  onRenameList: (title: string) => boolean
  onAddItem: (text: string) => boolean
  onUpdateItemText: (id: string, text: string) => boolean
  onToggleItem: (item: Item) => void
  onRemoveItem: (id: string) => void
}

export function ListEditor({
  list,
  completion,
  onRenameList,
  onAddItem,
  onUpdateItemText,
  onToggleItem,
  onRemoveItem,
}: ListEditorProps) {
  const filled = filledCount(list)

  /**
   * 完了を押せないときに、その行の下へ理由を出すための状態。
   *
   * **画面の上の方にまとめて出さない。** 押した行から離れた場所に出ても目に入らない。
   */
  const [promptedId, setPromptedId] = useState<string | null>(null)

  /**
   * 案内の**外側を押したら閉じる**（#83）。閉じ方が「同じ ✓ をもう一度押す」しか
   * 無いと邪魔になる。Esc でも閉じる（キーボードだけで操作している場合の逃げ道）。
   *
   * 出している行そのもの（`data-prompt-open` を付けた `li`）の中では閉じない。
   * 閉じてしまうと、案内の中のログインのリンクを押せず、
   * ✓ を押したときに「閉じてすぐ開く」ことになって閉じられなくなる。
   */
  useEffect(() => {
    if (promptedId === null) return

    const dismiss = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-prompt-open]')) return

      setPromptedId(null)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPromptedId(null)
    }

    // click ではなく pointerdown。押した時点で閉じる方が、邪魔だと感じた動きに合う
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [promptedId])

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
              completion={completion}
              prompted={promptedId === slot.item.id}
              onCommit={onUpdateItemText}
              onToggle={(item) => {
                if (completion.allowed) {
                  setPromptedId(null)
                  onToggleItem(item)
                  return
                }

                // **できないことを黙って無効化しない。** 無効化だけだと、
                // 機能が無いのか壊れているのか区別が付かない（PRODUCT_SPEC.md §2）。
                // もう一度押すと閉じる（案内を消す手段がこれしかない）
                setPromptedId((current) => (current === item.id ? null : item.id))
              }}
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
        if (isCommitKey(e)) e.currentTarget.blur()
      }}
      className="w-full rounded-md bg-transparent text-xl font-bold text-slate-900 focus:bg-white focus:outline-2 focus:outline-brand-deep"
    />
  )
}

/**
 * 🔴 **変換中の Enter を「入力の確定」として扱わない**（#79 で実際に踏んだ）。
 *
 * 日本語入力では、変換を確定する Enter が先に来る。これを入力の確定として
 * 扱って `setDraft('')` すると、React が持っている値と IME が後から書き込む文字が
 * ずれ、**文字が二重になったり、次の行の入力欄に残ったりする。**
 *
 * `isComposing` が `true` の間は何もしない。変換が終わってからの Enter だけを見る。
 * **キーボードでしか再現しないので、テストでは担保できない**（`TECH_STACK.md` §10）。
 */
function isCommitKey(event: React.KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.nativeEvent.isComposing
}

const ROW = 'flex items-center gap-2 py-1.5'
const ROW_BORDER = 'border-b border-brand/40'

/**
 * 番号の見た目。**枠が埋まっているかで濃さを変えない**（#79）。
 * 変えると、書ける枠が「使えない」ように見える。100 という枠を見せるのが目的。
 */
const NUMBER = 'w-8 shrink-0 text-right text-xs tabular-nums text-slate-500'
const TEXT_INPUT =
  'min-w-0 flex-1 rounded bg-transparent px-1 py-1 text-base focus:bg-white focus:outline-2 focus:outline-brand-deep'

function ItemRow({
  number,
  item,
  completion,
  prompted,
  onCommit,
  onToggle,
  onRemove,
}: {
  number: string
  item: Item
  completion: CompletionPermission
  prompted: boolean
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
    // 案内を重ねる基準にする（下の CompletionPrompt が absolute で浮く）。
    // data-prompt-open は「外側を押したら閉じる」の判定に使う（ListEditor 側）
    <li className={`relative ${ROW_BORDER}`} data-prompt-open={prompted ? '' : undefined}>
      <div className={ROW}>
        <span className={`${NUMBER} ${done ? 'text-brand-deep' : ''}`}>{number}</span>

        <button
          type="button"
          // 押されている状態を色だけで伝えない（読み上げと、色が見えない環境のため）
          aria-pressed={done}
          // 🔴 `disabled` にしない。押せないと押しても何も起きず、理由を出せない。
          // 支援技術には aria-disabled で「いまは効かない」と伝える
          aria-disabled={!completion.allowed}
          aria-label={
            completion.allowed
              ? done
                ? '完了を取り消す'
                : '完了にする'
              : '完了にする（ログインが要る）'
          }
          onClick={() => {
            onToggle(item)
          }}
          className={`size-6 shrink-0 rounded-full border-2 text-xs leading-none ${
            done ? 'border-brand-deep bg-brand-deep text-white' : 'border-brand bg-white text-white'
          } ${completion.allowed ? '' : 'border-dashed opacity-60'}`}
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
            if (isCommitKey(e)) e.currentTarget.blur()
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
      </div>

      {prompted && !completion.allowed && <CompletionPrompt reason={completion.reason} />}
    </li>
  )
}

/**
 * 完了を押したのに付けられなかったときの案内。**押した行のすぐ下に重ねて出す。**
 *
 * 🔴 **行の間に差し込まない**（#81）。差し込むとリスト全体が押し下がり、
 * 100行が一斉に動く。押した本人にも、何が起きたのか分からない。
 * `absolute` で浮かせて、**他の行の位置に影響させない。**
 *
 * 理由ごとに文言を分ける。未ログインと「状態が分からない」を同じ文にすると、
 * ログイン済みの利用者にログインを促してしまう（`toCompletionPermission` の注意書き）。
 */
function CompletionPrompt({
  reason,
}: {
  reason: Exclude<CompletionPermission, { allowed: true }>['reason']
}) {
  if (reason === 'session-loading') {
    return <PromptBox>ログイン状態を確認しています</PromptBox>
  }

  if (reason === 'session-unknown') {
    return <PromptBox>ログイン状態を確認できないため、いまは印を付けられません</PromptBox>
  }

  return (
    <PromptBox>
      {/* ログインの開始は POST なので <a> から叩けない。GET の入口はサーバー側にある */}
      <a href="/api/login/google" className="font-bold text-brand-deep underline">
        Googleでログイン
      </a>
      すると、「やった」印を付けられます
    </PromptBox>
  )
}

function PromptBox({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      // top-full = 行の下端。行の高さの分だけ下げるので、押した行に貼り付いて見える
      className="absolute top-full right-0 left-8 z-10 -mt-1 rounded bg-white px-2 py-1.5 text-xs text-slate-600 shadow-md ring-1 ring-brand"
    >
      {children}
    </p>
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
    <li className={`${ROW} ${ROW_BORDER}`}>
      <span className={NUMBER}>{number}</span>
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
          if (isCommitKey(e)) commit()
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
    <li className={`${ROW} ${ROW_BORDER}`} aria-hidden="true">
      <span className={NUMBER}>{number}</span>
      <span className="size-6 shrink-0 rounded-full border-2 border-dashed border-brand/50" />
      <span className="flex-1" />
    </li>
  )
}
