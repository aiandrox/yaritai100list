import { useState } from 'react'

import { PrivacyPage } from './PrivacyPage'
import { TermsPage } from './TermsPage'

/**
 * 規約とポリシーの確認（#319 / #322）。**同意の記録が無い人にだけ出す。**
 *
 * 🔴 **要約を置かない**（2026-09-01 の利用者の判断）。
 * 最初は要点3つを並べていたが、**中身を更新したときに要約だけ古くなる。**
 * ずれても気づける仕組みが無い以上、**全文をそのまま出す**方が安全。
 *
 * 🔴 **同じ本文を2箇所に書かない。** `/terms` と `/privacy` の中身を
 * **そのまま読み込んで**枠の中に出す。片方だけ直す事故が起きない。
 *
 * 🔴 **「同意しない」の出口を必ず置く。** ログアウトしてトップへ戻る。
 * **このアプリは未ログインでも書ける**ので、断っても何も失わない。
 *
 * ⚠️ **これは認可の仕組みではない。** 押させるための画面であって、
 * API を守るものではない（守るのは `requireUser` と `requireOwnedList`）。
 */
export function AgreementGate({
  onAgree,
  onDecline,
}: {
  onAgree: () => Promise<void>
  onDecline: () => void
}) {
  const [checked, setChecked] = useState(false)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

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
    <div className="mx-auto max-w-md rounded-lg bg-white px-5 py-6">
      <h1 className="text-lg font-bold text-slate-900">はじめる前に</h1>

      <p className="mt-3 text-sm leading-6 text-slate-600">
        利用規約とプライバシーポリシーを確認してください。
      </p>

      {/*
        🔴 **枠の中だけを流す。** 画面ごと長くすると、
        **同意のチェックとボタンが下に押し出されて見えなくなる。**

        ⚠️ 高さは `50dvh`。電話の縦幅の半分で、**枠の下に何があるかが見えている**
        （チェックとボタンが同時に視界に入る）
      */}
      <div className="mt-4 max-h-[50dvh] overflow-y-auto rounded border border-brand bg-brand-soft px-4 py-2">
        <TermsPage heading="h2" />
        <PrivacyPage heading="h2" />
      </div>

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

      {/*
        ⚠️ **チェックするまで押せない。**
        `disabled` にしているので、押しても何も起きない状態は作らない
      */}
      <button
        type="button"
        disabled={!checked || sending}
        onClick={agree}
        className="mt-4 w-full rounded-lg bg-brand-deep px-3 py-3 font-bold text-white disabled:opacity-50"
      >
        同意して始める
      </button>

      {/*
        断る側。**主のボタンと同じ強さにしない**（`ModalDecline` と同じ考え方）。
        押すとログアウトするので、**何が起きるかを言葉にしておく**
      */}
      <button type="button" onClick={onDecline} className="mt-3 w-full py-2 text-sm text-slate-500">
        同意しない（ログアウトする）
      </button>
    </div>
  )
}
