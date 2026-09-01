import { useEffect, useRef, useState } from 'react'

import { PrivacyPage } from './PrivacyPage'
import { TermsPage } from './TermsPage'

/**
 * 規約とポリシーの確認（#319 / #325）。**同意の記録が無い人にだけ出す。**
 *
 * 🔴 **閉じられないモーダルにする**（2026-09-01 の利用者の指示）。
 * 画面の一番手前に出し、**背景を押しても Esc でも閉じない。**
 * どの画面を直接開いても、同意するまでこれが手前にある。
 *
 * 🔴 **要約を置かない。** 中身を更新したときに**要約だけ古くなる。**
 * ずれても気づける仕組みが無い以上、全文をそのまま出す。
 *
 * 🔴 **同じ本文を2箇所に書かない。** `/terms` と `/privacy` の中身を
 * **そのまま読み込んで**枠に出す。片方だけ直す事故が起きない。
 *
 * ⚠️ **これは認可の仕組みではない。** 押させるための画面であって、
 * API を守るものではない（守るのは `requireUser` と `requireOwnedList`）。
 */
export function AgreementGate({
  onAgree,
  onDecline,
  declineLabel,
}: {
  onAgree: () => Promise<void>
  onDecline: () => void
  /** 断ったときに何が起きるかは、新規か既存かで変わる（`App` が文言を決める） */
  declineLabel: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [checked, setChecked] = useState(false)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  // 出したら開きっぱなし。**閉じる経路を作らない**
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])

  // 開いている間は背景を動かさない（`Modal.tsx` と同じ）
  useEffect(() => () => void (document.body.style.overflow = ''), [])

  const agree = () => {
    setSending(true)
    setFailed(false)

    void onAgree()
      .catch(() => {
        setFailed(true)
      })
      .finally(() => {
        setSending(false)
      })
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby="agreement-title"
      /*
       * 🔴 **閉じさせない。**
       * - `onCancel` を止めると **Esc で閉じない**
       * - 背景を押しても閉じる処理を**書かない**（`Modal.tsx` とはここが違う）
       * - × も「あとで」も置かない。**決めるまで進めない**
       */
      onCancel={(event) => {
        event.preventDefault()
      }}
      onToggle={(event) => {
        document.body.style.overflow = event.currentTarget.open ? 'hidden' : ''
      }}
      className="m-auto w-[calc(100%-1.5rem)] max-w-(--page-max-width) rounded-xl bg-white p-0 text-slate-900 backdrop:bg-slate-900/60"
    >
      <div className="max-h-[92dvh] overflow-y-auto px-4 py-5">
        <h1 id="agreement-title" className="text-lg font-bold text-slate-900">
          はじめる前に
        </h1>

        <p className="mt-2 text-sm leading-6 text-slate-600">
          利用規約とプライバシーポリシーを確認してください。
        </p>

        {/*
          🔴 **2つの文書を1つの枠に入れない**（2026-09-01 の利用者の指示）。
          別々の枠にして、**見出しは枠の外**に置く。
          1つにまとめると、スクロールしている間**いま何を読んでいるのか分からなくなる。**
        */}
        <Document title="利用規約">
          <TermsPage heading="none" />
        </Document>

        <Document title="プライバシーポリシー">
          <PrivacyPage heading="none" />
        </Document>

        {/*
          🔴 **押させる前に、押した意味を明示する。**
          ボタンだけだと「読んだ」のか「同意した」のかが曖昧になる
        */}
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm leading-6 text-slate-700">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => {
              setChecked(event.target.checked)
            }}
            className="mt-1.5 shrink-0"
          />
          <span>利用規約とプライバシーポリシーに同意します</span>
        </label>

        {failed && (
          <p role="alert" className="mt-3 text-sm text-brand-deep">
            記録できませんでした。通信を確かめて、もう一度お試しください
          </p>
        )}

        {/* ⚠️ **チェックするまで押せない。** 押しても何も起きない状態は作らない */}
        <button
          type="button"
          disabled={!checked || sending}
          onClick={agree}
          className="mt-4 w-full rounded-lg bg-brand-deep px-3 py-3 font-bold text-white disabled:opacity-50"
        >
          同意して始める
        </button>

        {/*
          断る側。**主のボタンと同じ強さにしない。**
          🔴 **何が起きるかを言葉にする。** 新規はアカウントごと消えるので、
          既存（ログアウトするだけ）と同じ文言にしてはいけない
        */}
        <button
          type="button"
          onClick={onDecline}
          className="mt-3 w-full py-2 text-sm text-slate-500"
        >
          {declineLabel}
        </button>
      </div>
    </dialog>
  )
}

/**
 * 1つの文書。**見出しは枠の外、本文だけが枠の中で流れる。**
 *
 * ⚠️ 高さは `30dvh`。**2つ並ぶ**ので、
 * **チェックとボタンが画面の下に押し出されない**大きさにしてある。
 */
function Document({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h2 className="text-sm font-bold text-slate-900">{title}</h2>

      <div className="mt-1 max-h-[30dvh] overflow-y-auto rounded border border-brand bg-brand-soft px-3 py-2">
        {children}
      </div>
    </section>
  )
}
