import {
  buildCompletedOn,
  COMPLETED_ON_MIN_YEAR,
  type CompletedPrecision,
  daysInMonth,
  formatCompletedOn,
  isCompleted,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
  toCompletedOn,
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
  /**
   * 完了日を入れる・直す・消す（#207 / #279）。**完了済みの項目にしか使わない。**
   *
   * 渡すのは `2026` / `2026-08` / `2026-08-14`（形が粒度を表す）。`null` は日付なし。
   */
  onChangeCompletedOn: (id: string, completedOn: string | null) => Promise<boolean>
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
  onChangeCompletedOn,
  onRemoveItem,
  onMoveItem,
}: ListEditorProps) {
  const filled = filledCount(list)
  const completed = completedCount(list)

  /**
   * ✓ を押したときに、**その行の下へ何かを浮かせる**ための状態。
   *
   * **画面の上の方にまとめて出さない。** 押した行から離れた場所に出ても目に入らない。
   *
   * 浮かぶものは2つあるが、**状態は1つしか持たない**（#207）。
   * 「その行に浮いているものが1つある」以上のことを覚える必要がない。
   *
   * - 押せないとき（未ログインなど）→ 理由の案内（`CompletionPrompt`）
   * - 押せて、かつ**完了済み**のとき → 完了の設定（`CompletionMenu`）
   *
   * 🔴 **条件が排他なので、2つが同時に出ることが構造上ない。**
   * 未ログインでは完了にできない（#77）ので、
   * 「押せない」と「完了済み」が両方成り立つ項目は存在しない。
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
                    // **できないことを黙って無効化しない。** 無効化だけだと、
                    // 機能が無いのか壊れているのか区別が付かない（PRODUCT_SPEC.md §2）。
                    // もう一度押すと閉じる（案内を消す手段がこれしかない）
                    if (!completion.allowed) {
                      setPromptedId((current) => (current === item.id ? null : item.id))
                      return
                    }

                    /**
                     * 🔴 **完了済みなら、その場では取り消さない**（#207）。
                     *
                     * 取り消すと完了日が消える。**いつ叶えたかは押し直しても戻らない**
                     * （押し直すとその日が入る。直した日付は戻ってこない）。
                     * 思い出として持っている値が、指が当たっただけで消えるのは重い。
                     *
                     * 増やす手数は**戻す側だけ。** 未完了の ✓ は今まで通り1回で付く。
                     * 🔴 **判定は粒度で**（#279）。日付なしの完了もここに入る
                     */
                    if (isCompleted(item.completedPrecision)) {
                      setPromptedId((current) => (current === item.id ? null : item.id))
                      return
                    }

                    setPromptedId(null)
                    void onToggleItem(item)
                  }}
                  onUncomplete={(item) => {
                    setPromptedId(null)
                    void onToggleItem(item)
                  }}
                  /**
                   * 🔴 **日付を直しても閉じない**（#207）。
                   *
                   * `<input type="date">` は**打っている途中でも `change` を出す。**
                   * 年の欄で「2」「20」「202」「2026」と打つと4回出る。
                   * ここで閉じると、**最初の1文字で画面から消えて続きが打てない。**
                   *
                   * 開けたままにすれば、途中の値は最後の値で上書きされ、
                   * 直った日付がその行に出るのを見て自分で閉じられる。
                   * **粒度を選び直す操作**（#279）でも同じ理由で閉じない。
                   */
                  onChangeCompletedOn={(id, completedOn) => {
                    void onChangeCompletedOn(id, completedOn)
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
  onUncomplete,
  onChangeCompletedOn,
  onRemove,
}: {
  number: string
  item: Item
  completion: CompletionPermission
  prompted: boolean
  onCommit: (id: string, text: string) => Promise<boolean>
  onToggle: (item: Item) => void
  onUncomplete: (item: Item) => void
  onChangeCompletedOn: (id: string, completedOn: string | null) => void
  onRemove: (id: string) => void
}) {
  const [draft, setDraft] = useState(item.text)
  // 🔴 **完了は粒度で判定する**（#279）。日付なしの完了も「済み」の見た目にする
  const done = isCompleted(item.completedPrecision)

  const completedAtDate = item.completedAt === null ? null : new Date(item.completedAt)
  const completedOn = formatCompletedOn(completedAtDate, item.completedPrecision)

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
          // 🔴 押しても取り消さなくなった（#207）ので「完了を取り消す」とは言えない。
          // 何が起きるか（設定が開く）を言う
          aria-label={
            completion.allowed
              ? done
                ? '完了の設定を開く'
                : '完了にする'
              : '完了にする（ログインが要る）'
          }
          // 押すと下に何か出る、と伝える。出ないときは付けない
          {...(completion.allowed && !done ? {} : { 'aria-expanded': prompted })}
          onClick={() => {
            onToggle(item)
          }}
          // 押した瞬間に案内を閉じない。閉じると直後の click で開き直り、
          // ✓ から閉じられなくなる（判定は ListEditor の dismiss）
          data-keep-prompt=""
          /**
           * 🔴 **未完了でも ✓ をうっすら出す**（#208）。
           *
           * 以前は白地に白文字で、**描いてはいるが見えなかった。**
           * ただの丸に見えるので「押すと何が起きるか」が分からない。
           * 削除の `×` も並べ替えの `⠿` も記号が見えているのに、ここだけ空だった。
           *
           * 薄い方は**枠と同じ色**（`text-brand`）にする。枠だけが浮いて見えず、
           * 「この丸ごと1つの押せるもの」に見える。
           * 濃い方は**塗りが反転する**（`bg-brand-deep` + 白文字）ので、
           * 色が見えない環境でも明暗の差で区別が付く。
           */
          className={`size-6 shrink-0 rounded-full border-2 text-xs leading-none ${
            done ? 'border-brand-deep bg-brand-deep text-white' : 'border-brand bg-white text-brand'
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

        {/*
          完了日。**粒度どおりに出す**（#279）。`2026/08/14` / `2026年8月` / `2026年`。
          🔴 **日付なしの完了では何も出さない**（欄そのものが出ない）。
          完了は打ち消し線・番号の色・「やった」の数が伝えている

          🔴 **押すと完了の設定が開く**（2026-08-15、#298）。
          直したいのは日付なのに、入口が ✓ しか無かった。
          `button` にしてキーボードからも押せるようにする。
          `data-keep-prompt` は ✓ と同じ理由（押した瞬間に閉じると開き直せない）
        */}
        {completedOn !== '' && (
          <button
            type="button"
            aria-label={`${number} 番目の完了日を直す`}
            aria-expanded={prompted}
            data-keep-prompt=""
            onClick={() => {
              onToggle(item)
            }}
            className="shrink-0 text-[10px] text-brand-deep underline tabular-nums"
          >
            {completedOn}
          </button>
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

      {/*
        浮かぶものは2つあるが**同時には出ない**（ListEditor の promptedId の注意書き）。
        未ログインでは完了にできないので、`!allowed` と `done` は両立しない
      */}
      {prompted &&
        (completion.allowed ? (
          // 🔴 **`done` で出す**（#279）。`completedAt` で見ると
          // 日付なしの完了で設定が開かず、**日付を入れる入口が無くなる**
          done && (
            <CompletionMenu
              completedAt={completedAtDate}
              completedPrecision={item.completedPrecision}
              onUncomplete={() => {
                onUncomplete(item)
              }}
              onChangeCompletedOn={(completedOn) => {
                onChangeCompletedOn(item.id, completedOn)
              }}
            />
          )
        ) : (
          <CompletionPrompt reason={completion.reason} />
        ))}
    </li>
  )
}

/**
 * 完了済みの ✓ を押したときに出る設定（#207 / #279）。
 *
 * 🔴 **2段にしない。** イシューの図は「未完了に戻す / 完了日時を変更する」の
 * 2択だったが、**日付の入力欄をその場に置く。** 押す回数が減る。
 *
 * 🔴 **「未完了に戻す」に確認を重ねない。** これを開いたこと自体が1段の確認。
 * 二重にすると、本当に戻したいときに邪魔になるだけ。
 *
 * 🔴 **粒度を選ばせない**（2026-08-15 の判断、#298）。
 * **年・月・日をそれぞれ入れて、入った値から粒度が決まる**（`buildCompletedOn`）。
 * 以前は粒度の `<select>` を先に選ばせていたが、**選んでから入れる順序が余計だった。**
 *
 * ```
 * 完了日 [2026]年 [8]月 [14]日
 * 日付なし / 未完了に戻す
 * ```
 *
 * 🔴 **上位が空なら下位は `-` に追従する。** 年が空なら月は選べず、月が空なら日は選べない。
 *
 * 🔴 **「日付なし」は押せるものとして出す**（2026-08-15 の指摘、#310）。
 * 年を空にしても日付なしになるが、**そう書いていないので暗黙すぎた。**
 * 覚えていない人がたどり着ける口を、押せる形で1つ置く（完了は取り消さない）。
 *
 * ⚠️ **打っている途中は送らない。** 年の欄で「2」「20」「202」と打つ間に送ると、
 * 途中の値が保存される（`1900` 年より前としてサーバーに断られる）。
 * **空にしたときだけは送る**（日付なしにする操作なので）。
 */
function CompletionMenu({
  completedAt,
  completedPrecision,
  onUncomplete,
  onChangeCompletedOn,
}: {
  completedAt: Date | null
  completedPrecision: CompletedPrecision | null
  onUncomplete: () => void
  onChangeCompletedOn: (completedOn: string | null) => void
}) {
  const current = toCompletedOn(completedAt, completedPrecision)

  // 既に入っている分を引き継ぐ（`2026-08-14` / `2026-08` / `2026` / null）
  const [year, setYear] = useState(current?.slice(0, 4) ?? '')
  const [month, setMonth] = useState(current?.slice(5, 7) ?? '')
  const [day, setDay] = useState(current?.slice(8, 10) ?? '')

  /**
   * 未来を選ばせないための上限。**親切のためだけ**（本当に弾くのはサーバー）。
   *
   * 🔴 **日本時間の今日から数える**（`toCompletedOn`）。サーバーは日本時間の暦日で
   * 判定するので（#279）、`getFullYear()` などで組み立てると
   * **時間帯によって1日ずれ、通らない日を選ばせたり、選べる日を隠したりする。**
   */
  const todayJst = toCompletedOn(new Date(), 'day') ?? ''
  const thisYear = Number(todayJst.slice(0, 4))
  const thisMonth = Number(todayJst.slice(5, 7))
  const today = Number(todayJst.slice(8, 10))

  /**
   * 年の欄が**送れる値になっているか。**
   *
   * 4桁揃っていることと、範囲（`1900` 〜 今年）を見る。
   * 🔴 **上限も見る。** 「2030」を送っても未来なのでサーバーが断るが、
   * **断られる要求をこちらから出さない**（画面が一瞬変わって戻るだけになる）。
   */
  const isYearFilled = (value: string) =>
    /^\d{4}$/.test(value) && Number(value) >= COMPLETED_ON_MIN_YEAR && Number(value) <= thisYear

  const inThisYear = (y: string) => isYearFilled(y) && Number(y) === thisYear
  const inThisMonth = (y: string, m: string) => inThisYear(y) && Number(m) === thisMonth

  /**
   * 3つの欄をまとめて確定する。
   *
   * 🔴 **上位を変えたときに下位を落とす。** 年を今年にしたら未来の月は成り立たないし、
   * うるう年を外れたら 2月29日は存在しない。**黙って別の日にしない**ために、
   * 成り立たなくなった下位は捨てて1段粗い粒度に落とす。
   */
  const commit = (next: { year: string; month: string; day: string }) => {
    const y = next.year
    let m = next.month
    let d = next.day

    if (!isYearFilled(y)) {
      // 年が無ければ月日は意味を持たない（空にしたなら日付なしとして送る）
      m = ''
      d = ''
    } else if (m !== '' && inThisYear(y) && Number(m) > thisMonth) {
      m = ''
      d = ''
    }

    if (
      d !== '' &&
      (m === '' || Number(d) > daysInMonth(y, m) || (inThisMonth(y, m) && Number(d) > today))
    ) {
      d = ''
    }

    setYear(next.year)
    setMonth(m)
    setDay(d)

    // 打っている途中（1〜3桁や範囲外）は送らない。**空にしたときは送る**
    if (next.year !== '' && !isYearFilled(next.year)) return

    onChangeCompletedOn(buildCompletedOn({ year: y, month: m, day: d }))
  }

  /** 月・日の選択肢。`-` は「そこまでは覚えていない」 */
  const options = (values: number[]) => [
    <option key="none" value="">
      -
    </option>,
    ...values.map((value) => (
      <option key={value} value={String(value).padStart(2, '0')}>
        {value}
      </option>
    )),
  ]

  const months = Array.from({ length: 12 }, (_, index) => index + 1).filter(
    // 今年なら、**まだ来ていない月は出さない**
    (value) => !(inThisYear(year) && value > thisMonth),
  )

  const days = Array.from({ length: daysInMonth(year, month) }, (_, index) => index + 1).filter(
    // 今月なら、**まだ来ていない日は出さない**
    (value) => !(inThisMonth(year, month) && value > today),
  )

  return (
    <PromptBox>
      {/* 横に並べる。入らない幅では折り返す（狭い端末で切れないように） */}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex flex-wrap items-center gap-1">
          <span className="mr-1 shrink-0">完了日</span>

          <input
            type="number"
            inputMode="numeric"
            value={year}
            aria-label="完了した年"
            placeholder={String(thisYear)}
            /**
             * ⚠️ **`min` / `max` は親切のためだけ。** 手で組み立てた要求は通るので、
             * 本当に弾くのはサーバー（`isFutureCompletedAt` と `parseCompletedOn`）。
             */
            min={COMPLETED_ON_MIN_YEAR}
            max={thisYear}
            onChange={(event) => {
              commit({ year: event.target.value, month, day })
            }}
            className={`${FIELD} w-[4.5rem] tabular-nums`}
          />
          <span className="shrink-0">年</span>

          <select
            value={month}
            aria-label="完了した月"
            // 🔴 **年が空なら選ばせない。** 月だけでは日付にならないので、
            // 選べる形にしておくと「選んだのに何も起きない」ことになる
            disabled={!isYearFilled(year)}
            onChange={(event) => {
              commit({ year, month: event.target.value, day })
            }}
            className={SELECT}
          >
            {options(months)}
          </select>
          <span className="shrink-0">月</span>

          <select
            value={day}
            aria-label="完了した日"
            // 月が空なら日は選ばせない（同じ理由）
            disabled={month === ''}
            onChange={(event) => {
              commit({ year, month, day: event.target.value })
            }}
            className={SELECT}
          >
            {options(days)}
          </select>
          <span className="shrink-0">日</span>
        </span>

        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/*
            🔴 **「日付なし」の入口**（#310）。年を空にするのと同じことをする。
            **日付が入っているときだけ出す**（既に日付なしなら押しても何も起きない）。
            文言は #279 で利用者が選んだ「日付なし」をそのまま使う
          */}
          {year !== '' && (
            <button
              type="button"
              onClick={() => {
                commit({ year: '', month: '', day: '' })
              }}
              className={ACTION}
            >
              日付なし
            </button>
          )}

          <button type="button" onClick={onUncomplete} className={ACTION}>
            未完了に戻す
          </button>
        </span>
      </span>
    </PromptBox>
  )
}

/** 完了の設定の押せる文字。**「日付なし」と「未完了に戻す」で同じ見た目にする**（#310） */
const ACTION = 'font-bold text-brand-deep underline'

/** 完了の設定の入力欄。**同じ見た目を3つで使う**（年・月・日） */
const FIELD = 'min-w-0 rounded border border-brand bg-white px-1 py-0.5 text-xs text-slate-900'

const SELECT = `${FIELD} shrink-0`

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
      すると、やった項目にチェックを入れられます
      {/*
        🔴 **ここに「ほかにできること」を置かない**（#211）。
        押した行に貼り付いた小さな案内で、**いま押した1つのことだけ**を答える場所。
        まとめて読ませる入口は保存の案内の側にある（`ListPage.tsx` の `StorageNotice`）
      */}
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
