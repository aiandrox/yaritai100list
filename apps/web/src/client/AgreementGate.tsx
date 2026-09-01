import { useState } from 'react'
import { Link } from 'wouter'

/**
 * 規約とポリシーの確認（#319）。**同意の記録が無い人にだけ出す。**
 *
 * 🔴 **全文を出さない。** 出しても読まれない。
 * **知らずに使うと困ることだけ**を並べて、全文はリンクにする。
 * 一番効くのは「**全体に公開すると、他の人に取り入れられる**」。
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
        利用規約とプライバシーポリシーを用意しました。要点は次の3つです。
      </p>

      <ul className="mt-4 flex flex-col gap-2">
        <Point>書いたものは、あなたのものです</Point>
        <Point>
          <strong className="font-bold text-slate-900">「全体に公開」にしたやりたいこと</strong>
          は、作者を伏せた形で「さがす」に並び、ほかの人が自分のリストに取り入れられます
        </Point>
        <Point>アカウントはいつでも削除できます。書いたものもすべて消えます</Point>
      </ul>

      <p className="mt-4 text-sm leading-6 text-slate-600">
        全文は
        <Link href="/terms" className="font-bold text-brand-deep underline">
          利用規約
        </Link>
        と
        <Link href="/privacy" className="font-bold text-brand-deep underline">
          プライバシーポリシー
        </Link>
        をご覧ください。
      </p>

      {failed && (
        <p role="alert" className="mt-3 text-sm text-brand-deep">
          記録できませんでした。通信を確かめて、もう一度お試しください
        </p>
      )}

      <button
        type="button"
        disabled={sending}
        onClick={agree}
        className="mt-5 w-full rounded-lg bg-brand-deep px-3 py-3 font-bold text-white disabled:opacity-50"
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

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="rounded-lg bg-brand-soft px-3 py-3 text-sm leading-6 text-slate-700">
      {children}
    </li>
  )
}
