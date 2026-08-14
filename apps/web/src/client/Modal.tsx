import { useEffect, useId } from 'react'

/**
 * モーダルの外枠（#282）。**中身以外は全部ここが決める。**
 *
 * 🔴 **見た目を揃えるために切り出した**（2026-08-14 の利用者の指示）。
 * 「ログインすると、できること」（#213）と共有のお誘い（#276）で、
 * 角の丸み・余白・見出しの位置・閉じ方が**別々に書かれていた。**
 * 増えるたびに少しずつずれるので、**枠は1つにする。**
 *
 * 🔴 **`<dialog>` を使う。自前で作らない。**
 * Esc で閉じる・背景を押せなくする・フォーカスを閉じ込める・
 * 背景に `inert` を効かせる、を**ブラウザがやってくれる**
 * （`TECH_STACK.md` §1 の「概念の数が少ないか」）。
 *
 * ⚠️ **背景のスクロールだけは止めてくれない。** そこはここで止める。
 *
 * ⚠️ **開け閉めはここでやらない。** 呼ぶ側が `ref` を持って
 * `showModal()` / `close()` する。開く条件は画面ごとに違う
 * （押したら開く／条件が揃ったら開く）ので、ここに持ち込むと分岐が増える。
 */
export function Modal({
  ref,
  title,
  onClose,
  children,
}: {
  ref: React.RefObject<HTMLDialogElement | null>
  /** 見出し。**読み上げの名前にもなる**（`aria-labelledby`） */
  title: string
  /** 閉じたあとに呼ばれる。開いた側の状態を戻すため */
  onClose?: (() => void) | undefined
  children: React.ReactNode
}) {
  const titleId = useId()

  /**
   * 開いている間は背景を動かさない。
   *
   * 閉じたときは `onToggle` で戻すが、**開いたまま画面が消える**こともある
   * （リンクを押して別の画面へ移るなど）。そのときのために片付けも置く。
   */
  useEffect(() => () => void (document.body.style.overflow = ''), [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClick={(event) => {
        // 背景を押したら閉じる。`<dialog>` 自身の矩形は背景を含むので、
        // **中身の外側を押したかどうか**で判断する
        if (event.target === event.currentTarget) event.currentTarget.close()
      }}
      onToggle={(event) => {
        document.body.style.overflow = event.currentTarget.open ? 'hidden' : ''
      }}
      {...(onClose === undefined ? {} : { onClose })}
      className="m-auto w-[calc(100%-2rem)] max-w-(--page-max-width) rounded-xl bg-white p-0 text-slate-900 backdrop:bg-slate-900/50"
    >
      {/* 画面より高くなったら中だけ流す（長い中身でもボタンに届く） */}
      <div className="max-h-[85dvh] overflow-auto px-5 pt-5 pb-6">
        {/*
          閉じるを右上に置く。**読み終わる前でも抜けられる場所が要る。**
          ⚠️ `float` にしてあるので、**見出しはこの分だけ回り込む。**
          `absolute` にすると長い見出しが下を通って重なる
        */}
        <button
          type="button"
          aria-label="閉じる"
          onClick={() => {
            ref.current?.close()
          }}
          className="float-right -mt-1 -mr-1 px-2 py-1 text-lg text-slate-400"
        >
          ×
        </button>

        <h2 id={titleId} className="text-center text-lg font-bold">
          {title}
        </h2>

        {children}
      </div>
    </dialog>
  )
}
