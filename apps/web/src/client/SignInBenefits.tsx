import { useEffect, useRef } from 'react'

import { SIGN_IN_BENEFITS } from './model'

/**
 * ログインすると何ができるかを、まとめて見せる（#204）。
 *
 * 導線が3箇所にあり、**それぞれ1つの利点しか言っていなかった。**
 * その場の文言は残す（文脈に合った1つを先に言う方が分かりやすい）が、
 * **全部を読める入口をその横に置く。**
 *
 * 🔴 **中身は `model.ts` の `SIGN_IN_BENEFITS` 1箇所。**
 * 画面ごとに書き分けると必ずずれる。
 */

/**
 * `<dialog>` を使う。**自前で作らない。**
 *
 * Esc で閉じる・背景を押せなくする・フォーカスを閉じ込める・
 * 背景に `inert` を効かせる、を**ブラウザがやってくれる**
 * （`TECH_STACK.md` §1 の「概念の数が少ないか」）。
 *
 * ⚠️ **背景のスクロールだけは止めてくれない。** そこは自分で止める。
 */
export function SignInBenefits({ label = 'ほかにできること' }: { label?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)

  return (
    <>
      <button
        type="button"
        // ⚠️ 完了の案内（`ListEditor.tsx`）の中に置くので、
        // **押した瞬間に案内ごと消えないようにする**
        data-keep-prompt=""
        onClick={() => {
          dialog.current?.showModal()
        }}
        className="font-bold text-brand-deep underline"
      >
        {label}
      </button>

      <Dialog ref={dialog} />
    </>
  )
}

function Dialog({ ref }: { ref: React.RefObject<HTMLDialogElement | null> }) {
  /**
   * 開いている間は背景を動かさない。**`<dialog>` はここまで面倒を見てくれない。**
   *
   * 閉じたときは `onToggle` で戻すが、**開いたまま画面が消える**こともある
   * （ログインへ飛ぶなど）。そのときのために片付けも置く。
   */
  useEffect(() => () => void (document.body.style.overflow = ''), [])

  return (
    <dialog
      ref={ref}
      aria-labelledby="sign-in-benefits-title"
      onClick={(event) => {
        // 背景を押したら閉じる。`<dialog>` 自身の矩形は背景を含むので、
        // **中身の外側を押したかどうか**で判断する
        if (event.target === event.currentTarget) event.currentTarget.close()
      }}
      onToggle={(event) => {
        document.body.style.overflow = event.currentTarget.open ? 'hidden' : ''
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-(--page-max-width) rounded bg-white p-0 text-slate-900 backdrop:bg-slate-900/40"
    >
      <div className="max-h-[80dvh] overflow-auto px-4 py-4">
        <h2 id="sign-in-benefits-title" className="text-lg font-bold">
          ログインすると、できること
        </h2>

        <ul className="mt-3">
          {SIGN_IN_BENEFITS.map((benefit) => (
            <li key={benefit.title} className="border-b border-brand/40 py-3 last:border-b-0">
              <p className="font-bold">{benefit.title}</p>
              {/* **失うかもしれないことを先に言う。** 利点だけ並べても差が伝わらない */}
              <p className="mt-1 text-xs text-slate-500">いま: {benefit.without}</p>
              <p className="mt-0.5 text-xs text-brand-deep">ログイン後: {benefit.with}</p>
            </li>
          ))}
        </ul>

        {/*
          🔴 **この中にもログインの入口を置く。**
          読んで「したくなった」ときに、閉じて探し直させない。
          ログインの開始は POST なので <a> から叩けない（GET の入口はサーバー側）
        */}
        <a
          href="/api/login/google"
          className="mt-4 block rounded bg-brand-deep px-3 py-2 text-center font-bold text-white"
        >
          Googleでログイン
        </a>

        <button
          type="button"
          onClick={() => {
            ref.current?.close()
          }}
          className="mt-2 w-full px-3 py-2 text-center text-sm text-slate-500"
        >
          閉じる
        </button>
      </div>
    </dialog>
  )
}
