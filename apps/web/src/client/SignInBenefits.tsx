import { useEffect, useRef } from 'react'

import { Modal } from './Modal'
import { signInBenefits, WROTE_ALL_TITLE, type SignInBenefit } from './model'

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
 * 枠は `Modal.tsx`（#282）。**`<dialog>` の作法はそちらに寄せてある。**
 * ここが決めるのは中身と、開くきっかけだけ。
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
 * 未ログインで**100個すべて書き終えた**ときに出す（#284）。
 *
 * #276 のお誘い（共有）はログイン中だけだった。誘う先がログインの向こう側にあるため。
 * しかし**100個書き終えるのは一番大きな節目**で、そこで何も起きないのはもったいない。
 * 未ログインの人にとっての次の一歩は共有ではなく、**まずログイン**（`PRODUCT_SPEC.md` §2）。
 *
 * 🔴 **中身は「ログインすると、できること」と同じものを使う**（#204 の決定）。
 * **変えるのは見出しだけ。** 書き分けると必ずずれる。
 */
export function WroteAllInvite({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open) dialog.current?.showModal()
  }, [open])

  // 🔴 **共有のお誘い（#306）と同じ文言を使う。** 書き分けると必ずずれる
  return <Dialog ref={dialog} title={WROTE_ALL_TITLE} onClose={onClose} />
}

/**
 * 目印の線画（#213）。
 *
 * 🔴 **絵文字をやめた。** 環境ごとに形が変わるうえ、賑やかすぎて中身より目立つ。
 *
 * ⚠️ **画像ファイルにしない。** この画面は未ログインの人が最初に見るので、
 * 取りに行く回数を増やしたくない。**線画なら文字色に乗せられる**ので、
 * 配色を変えたときに追従する（`currentColor`）。
 */
const ICON_PATHS: Record<SignInBenefit['icon'], React.ReactNode> = {
  // 雲。**サーバーに置かれる**ことを表す
  save: <path d="M7 18h10a4 4 0 0 0 .4-8A6 6 0 0 0 6 10.5 3.75 3.75 0 0 0 7 18Z" />,
  check: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </>
  ),
  // 重なった紙。**リストが複数ある**ことを表す
  lists: (
    <>
      <rect x="4" y="7" width="12" height="13" rx="2" />
      <path d="M8 4h10a2 2 0 0 1 2 2v11" />
    </>
  ),
  link: (
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.66 0l2.5-2.5a4 4 0 0 0-5.66-5.66l-1.2 1.2" />
      <path d="M13.5 10.5a4 4 0 0 0-5.66 0l-2.5 2.5a4 4 0 0 0 5.66 5.66l1.2-1.2" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <circle cx="8.5" cy="10" r="1.4" />
      <path d="m4.5 17 4.2-4.2a1.5 1.5 0 0 1 2.1 0l3 3 1.7-1.7a1.5 1.5 0 0 1 2.1 0l2.9 2.9" />
    </>
  ),
}

function BenefitIcon({ name }: { name: SignInBenefit['icon'] }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-brand-deep"
    >
      {ICON_PATHS[name]}
    </svg>
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
  'mt-5 flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-3 text-center font-bold text-slate-700 shadow-sm'

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

function Dialog({
  ref,
  title = 'ログインすると、できること',
  onClose,
}: {
  ref: React.RefObject<HTMLDialogElement | null>
  /** 🔴 **見出しだけを差し替える**（#284）。中身は書き分けない */
  title?: string
  onClose?: () => void
}) {
  return (
    <Modal ref={ref} title={title} onClose={onClose}>
      {/*
        🔴 **1つずつ札に分ける**（#213）。
        文だけを縦に並べると、**どこからどこまでが1つの話か分からず読む気にならない。**
        目印（絵文字）・余白・背景の3つで区切りを作る。文面そのものは変えない
      */}
      <ul className="mt-4 flex flex-col gap-2">
        {/* 年を含む文言があるので、**開くたびに今の年で作る**（`signInBenefits`） */}
        {signInBenefits(new Date()).map((benefit) => (
          <li
            key={benefit.text}
            className="flex items-start gap-3 rounded-lg bg-brand-soft px-3 py-3"
          >
            <BenefitIcon name={benefit.icon} />
            <span className="flex-1 text-sm leading-6">{benefit.text}</span>
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
    </Modal>
  )
}
