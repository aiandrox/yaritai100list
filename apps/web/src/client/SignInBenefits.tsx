import { useEffect, useRef } from 'react'

import { signInBenefits } from './model'

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

/**
 * Google の見た目に寄せる（#211）。
 *
 * ⚠️ **サービスの色（ピンク）を使わない。** ここは「Google に飛ぶ」ボタンで、
 * **どこへ行くのかが見て分かる方が押しやすい。**
 * 白地・グレーの枠・濃いグレーの文字は Google のボタンの作法に合わせたもの。
 */
const GOOGLE_BUTTON =
  'mt-4 flex items-center justify-center gap-2 rounded border border-slate-300 bg-white px-3 py-2.5 text-center font-bold text-slate-700 shadow-sm'

/** Google の「G」。**4色は Google のもの**なので勝手に変えない。 */
function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
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
          {/* 年を含む文言があるので、**開くたびに今の年で作る**（`signInBenefits`） */}
          {signInBenefits(new Date()).map((benefit) => (
            <li key={benefit} className="border-b border-brand/40 py-3 text-sm last:border-b-0">
              {benefit}
            </li>
          ))}
        </ul>

        {/*
          🔴 **この中にもログインの入口を置く。**
          読んで「したくなった」ときに、閉じて探し直させない。
          ログインの開始は POST なので <a> から叩けない（GET の入口はサーバー側）
        */}
        <a href="/api/login/google" className={GOOGLE_BUTTON}>
          <GoogleLogo />
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
