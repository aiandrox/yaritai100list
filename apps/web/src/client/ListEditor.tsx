import {
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
} from '@yaritai100list/shared'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useEffect, useRef, useState } from 'react'

import {
  completedCount,
  filledCount,
  toSlots,
  type CompletionPermission,
  type Item,
  type LocalList,
} from './model'

/**
 * リストの編集画面。**ここに置くのは描画と入力欄の下書きだけ。**
 *
 * 何が正しい値かは `model.ts` の純関数が決める（`TECH_STACK.md` §10）。
 * このファイルはテストしない。
 *
 * 変更を伝える関数は**受理されたかを返す。** 入力欄は受理されたときだけ下書きを捨てる。
 * 捨ててから拒否されると、利用者が書いた文字が黙って消える。
 *
 * ログイン中はサーバーへの往復になるので**非同期**（`Promise<boolean>`）。
 * 保存先が localStorage かサーバーかを、この画面は区別しない。
 */
interface ListEditorProps {
  list: LocalList
  /** 「やった」印を付けられるか。判定は `model.ts` の `toCompletionPermission`。 */
  completion: CompletionPermission
  onRenameList: (title: string) => Promise<boolean>
  onAddItem: (text: string) => Promise<boolean>
  onUpdateItemText: (id: string, text: string) => Promise<boolean>
  onToggleItem: (item: Item) => Promise<boolean>
  onRemoveItem: (id: string) => Promise<boolean>
  /** 移動先の位置（0 始まり）へ動かす。**ずらす量ではない**（#166） */
  onMoveItem: (id: string, toIndex: number) => Promise<boolean>
}

export function ListEditor({
  list,
  completion,
  onRenameList,
  onAddItem,
  onUpdateItemText,
  onToggleItem,
  onRemoveItem,
  onMoveItem,
}: ListEditorProps) {
  const filled = filledCount(list)
  const completed = completedCount(list)

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
   * 🔴 **「外側」は案内の箱の外側。行の外側ではない**（#85 で直した）。
   * 行を基準にすると、案内のすぐ左にある項目の入力欄を押しても閉じず、
   * **見えている案内の外を押しているのに消えない。**
   *
   * 閉じない例外は2つだけ:
   * - 案内の中（ログインのリンクを押せなくなる）
   * - ✓ のボタン（押した瞬間に閉じると、直後の click で開き直して閉じられない）
   */
  useEffect(() => {
    if (promptedId === null) return

    const dismiss = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-keep-prompt]')) return

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

  /** 並べ替えの対象は**書いた項目だけ。** 空欄の枠は動かさない */
  const sortableIds = list.items.map((item) => item.id)

  /**
   * 掴み方。
   *
   * ⚠️ **すぐには始めない**（`distance: 8`）。スマホで縦スクロールと取り合いになり、
   * 一覧をなぞろうとしただけで項目が持ち上がる。
   *
   * 🔴 **キーボードでも動かせるようにする。** ▲▼ を消した（#166）ので、
   * これが無いとキーボードだけの人が並べ替えられなくなる。
   * 掴む場所にフォーカスして Space、矢印で移動、Space で置く。
   */
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  /**
   * 離したときに1回だけ送る（`useList` の `moveItem`）。
   *
   * **動いていなければ何もしない。** 掴んで同じ場所に置いただけで送ると、
   * 並びは変わらないのに `updated_at` が動く。
   */
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (over === null || active.id === over.id) return

    const toIndex = sortableIds.indexOf(String(over.id))
    if (toIndex === -1) return

    void onMoveItem(String(active.id), toIndex)
  }

  return (
    <div>
      <ListTitleField title={list.title} onRename={onRenameList} />

      {/*
        2つの数字は**別のことを言っている**（#145）。
        「書けた」は 100 という枠がまだ埋まっていないことを見せる（PRODUCT_SPEC.md §1）。
        「やった」はそのうち何個叶えたか。**片方に置き換えない。**

        **分母が違う**（#168）。「書けた」は 100（枠がいくつ空いているか）、
        「やった」は書いた数（**書いていない枠を「やっていない」と数えない**）
      */}
      <p className="mt-1 flex items-baseline gap-3 text-brand-deep">
        <span className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tabular-nums">{filled}</span>
          <span className="text-sm tabular-nums">/ {ITEMS_PER_LIST_MAX}</span>
          <span className="text-xs text-slate-500">書けた</span>
        </span>

        <span className="flex items-baseline gap-1">
          <span className="text-2xl font-bold tabular-nums">{completed}</span>
          <span className="text-sm tabular-nums">/ {filled}</span>
          <span className="text-xs text-slate-500">やった</span>
        </span>
      </p>

      {/*
        ドラッグでの並べ替え（#166）。**掴む場所を分けてある**（行全体ではない）。
        行全体にすると、項目の本文を選ぼうとしただけでドラッグが始まる。

        ⚠️ **これはテストで担保できない**（jsdom に座標が無い。`TECH_STACK.md` §10）。
        壊れても気づけるのは目視だけ。
      */}
      <DndContext
        sensors={sensors}
        // 上下にしか動かない一覧なので、横のずれと枠外へのはみ出しを止める
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
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
                      void onToggleItem(item)
                      return
                    }

                    // **できないことを黙って無効化しない。** 無効化だけだと、
                    // 機能が無いのか壊れているのか区別が付かない（PRODUCT_SPEC.md §2）。
                    // もう一度押すと閉じる（案内を消す手段がこれしかない）
                    setPromptedId((current) => (current === item.id ? null : item.id))
                  }}
                  onRemove={(id) => void onRemoveItem(id)}
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
        </SortableContext>
      </DndContext>
    </div>
  )
}

/**
 * リストのタイトル。**普段は見出しで、押したときだけ入力欄になる**（#144）。
 *
 * ずっと入力欄にしていると2つ困る:
 *
 * - **編集できることが分からない。** 枠線が無いと見出しにしか見えない
 * - **読むつもりで触っただけで書き換えられる状態になる**
 *
 * Esc で取り消して元の値に戻す。**確定と取り消しの両方を用意する**
 * （入力欄しか無いと、間違えて消したときに戻す手段が無い）。
 */
function ListTitleField({
  title,
  onRename,
}: {
  title: string
  onRename: (t: string) => Promise<boolean>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const input = useRef<HTMLInputElement>(null)

  /**
   * 確定して閉じた直後の `blur` を無視するための印（#167）。
   *
   * **外を押したら取り消し**にしたので、`blur` は取り消しの合図になった。
   * ただし Enter での確定も `blur()` を通るため、そのままだと
   * **確定した直後に取り消しが走る。**
   */
  const committing = useRef(false)

  // 押した後にもう一度押させない
  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])

  const commit = async () => {
    committing.current = true
    setEditing(false)

    if (draft === title) return
    if (!(await onRename(draft))) setDraft(title) // 拒否されたら実際の値に戻す
  }

  const cancel = () => {
    setDraft(title)
    setEditing(false)
  }

  if (!editing) {
    return (
      <div className="flex items-baseline gap-2">
        <h1 className="min-w-0 flex-1 text-xl font-bold break-words text-slate-900">{title}</h1>

        <button
          type="button"
          aria-label="リストのタイトルを変える"
          onClick={() => {
            // 直前に拒否された下書きが残っていることがあるので、開くときに揃える
            setDraft(title)
            setEditing(true)
          }}
          className="shrink-0 text-xs text-brand-deep underline"
        >
          変更
        </button>
      </div>
    )
  }

  return (
    <input
      ref={input}
      type="text"
      value={draft}
      aria-label="リストのタイトル"
      // 上限は shared の定数。ここに数字を書かない（CLAUDE.md の不変条件）
      maxLength={LIST_TITLE_MAX_LENGTH}
      onChange={(e) => {
        setDraft(e.target.value)
      }}
      // 🔴 **外を押したら取り消す**（#167）。確定は Enter だけ。
      // 読むつもりで触った流れで書き換わらないようにするため
      onBlur={() => {
        if (committing.current) {
          committing.current = false
          return
        }

        cancel()
      }}
      onKeyDown={(e) => {
        // 確定。**blur を通すので、上の印で取り消しと見分ける**
        if (isCommitKey(e)) void commit()
        if (e.key === 'Escape') cancel()
      }}
      className="w-full rounded-md bg-white text-xl font-bold text-slate-900 outline-2 outline-brand-deep"
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

/**
 * 行の骨格。🔴 **高さをここで決める**（#147）。
 *
 * 中身に決めさせると、**入力欄のある行（32px）と、無い行（丸だけで 24px）で
 * 段差ができる。** 100行並ぶ画面なので、書けた枠と空の枠の境目で目立つ。
 *
 * `min-h-11`（44px）は、いまの入力欄（`text-base` + `py-1` = 32px）に
 * 上下の余白（`py-1.5` = 12px）を足した高さ。**中身が変わっても行は動かない。**
 * `h-11` にしないのは、将来この中に背の高いものを置いたときに切れないため。
 */
const ROW = 'flex min-h-11 items-center gap-2 py-1.5'
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
  onCommit: (id: string, text: string) => Promise<boolean>
  onToggle: (item: Item) => void
  onRemove: (id: string) => void
}) {
  const [draft, setDraft] = useState(item.text)
  const done = item.completedAt !== null

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  })

  const commit = async () => {
    if (draft === item.text) return
    if (!(await onCommit(item.id, draft))) setDraft(item.text)
  }

  return (
    // 案内を重ねる基準にする（下の CompletionPrompt が absolute で浮く）
    <li
      ref={setNodeRef}
      style={{
        // 横には動かさないので y だけ見る（`restrictToVerticalAxis`）
        transform: transform === null ? undefined : `translate3d(0, ${String(transform.y)}px, 0)`,
        transition: transition ?? undefined,
        // 掴んでいる行を前に出す。出さないと下の行の後ろに潜る
        zIndex: isDragging ? 1 : undefined,
        position: 'relative',
      }}
      className={`${ROW_BORDER} ${isDragging ? 'bg-white shadow-md' : ''}`}
    >
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
          // 押した瞬間に案内を閉じない。閉じると直後の click で開き直り、
          // ✓ から閉じられなくなる（判定は ListEditor の dismiss）
          data-keep-prompt=""
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
          onBlur={() => void commit()}
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

        {/*
          掴む場所（#166）。**行全体を掴めるようにしない。**
          本文を選ぼうとしただけでドラッグが始まってしまう。

          🔴 **`button` にする。** キーボードでフォーカスでき、
          Space で持ち上げて矢印で動かせる（dnd-kit の KeyboardSensor）。
          ▲▼ を消したので、**ここがキーボードからの唯一の入口。**

          `touch-action: none` はここだけに付ける。一覧全体に付けると縦スクロールが死ぬ
        */}
        <button
          type="button"
          aria-label={`${number} 番目を並べ替える`}
          {...attributes}
          {...listeners}
          className="shrink-0 touch-none px-1 text-sm text-slate-400"
        >
          ⠿
        </button>

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
      // この中を押しても閉じない（ログインのリンクを押せなくなるため）
      data-keep-prompt=""
      // top-full = 行の下端。行の高さの分だけ下げるので、押した行に貼り付いて見える
      className="absolute top-full right-0 left-8 z-10 -mt-1 rounded bg-white px-2 py-1.5 text-xs text-slate-600 shadow-md ring-1 ring-brand"
    >
      {children}
    </p>
  )
}

function NextRow({ number, onAdd }: { number: string; onAdd: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState('')

  const commit = async () => {
    // 空白だけの入力は「書いていない」として扱う。エラーを出す場面ではない
    if (draft.trim() === '') {
      setDraft('')
      return
    }

    if (await onAdd(draft)) setDraft('')
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
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          // Enter で続けて書ける。この入力欄は使い回されるのでフォーカスは外れない
          if (isCommitKey(e)) void commit()
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
