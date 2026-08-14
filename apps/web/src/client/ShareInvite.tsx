import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'

import { canUseShareSheet, isShareCancelled, shareUrl } from './model'
import type { ShareState } from './useList'

/**
 * 叶えたとき・100個書き終えたときに出す、共有へのお誘い（#276）。
 *
 * **人が貼りたくなるのは、空のリストではなく達成したとき。**
 * それまでの導線は「共有の設定を開く → 公開範囲を変える → URL をコピー」だけで、
 * **一番気分が乗っている瞬間には何も起きなかった。**
 *
 * 🔴 **公開範囲で中身を変える**（2026-08-14 の利用者の指示）。いまの状態から次の一歩が違う。
 *
 * | いまの公開範囲 | 出すもの |
 * |---|---|
 * | 非公開 | 「みんなにもリストを見せませんか？」→ 共有の設定へ |
 * | 全公開・リンク限定 | 「SNSでみんなに見せませんか？」→ **その場で送れる** |
 *
 * 🔴 **ここで公開範囲を変えられるようにしない。** 誘いの場で設定を触らせない。
 *
 * ⚠️ **出すかどうかを決めるのはここではない**（`ListPage`）。
 * ここは「開けと言われたら開く」だけ。判断は `model.ts` の純関数に置いてある。
 */

/**
 * `<dialog>` を使う。**自前で作らない**（`SignInBenefits.tsx` と同じ理由）。
 *
 * Esc で閉じる・背景を押せなくする・フォーカスを閉じ込める、を
 * ブラウザがやってくれる。**背景のスクロールだけは自分で止める。**
 */
export function ShareInvite({
  listId,
  share,
  open,
  onClose,
}: {
  listId: string
  share: ShareState
  open: boolean
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open) dialog.current?.showModal()
  }, [open])

  // 開いたまま画面が消えることがある（共有の設定へ移るなど）。そのときの片付け
  useEffect(() => () => void (document.body.style.overflow = ''), [])

  return (
    <dialog
      ref={dialog}
      aria-labelledby="share-invite-title"
      onClick={(event) => {
        // 背景を押したら閉じる。`<dialog>` 自身の矩形は背景を含むので、
        // **中身の外側を押したかどうか**で判断する
        if (event.target === event.currentTarget) event.currentTarget.close()
      }}
      onToggle={(event) => {
        document.body.style.overflow = event.currentTarget.open ? 'hidden' : ''
      }}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-(--page-max-width) rounded-xl bg-white p-0 text-slate-900 backdrop:bg-slate-900/50"
    >
      {/*
        ⚠️ **右上の × は置かない**（`SignInBenefits` とは違う）。
        こちらは下に「閉じる」があるので**抜け道が2つになる**うえ、
        見出しが長いので × を避けると「か？」だけが2行目に落ちた。
        Esc と背景押しは `<dialog>` が面倒を見ている
      */}
      <div className="px-5 pt-5 pb-6">
        {share.visibility === 'private' ? (
          <NotSharedYet listId={listId} onClose={() => dialog.current?.close()} />
        ) : (
          <AlreadyShared shareId={share.shareId} onClose={() => dialog.current?.close()} />
        )}
      </div>
    </dialog>
  )
}

/**
 * まだ非公開のとき。**渡す先が無いので、まず公開範囲を決めてもらう。**
 *
 * 🔴 **文言は利用者が書いたもの**（2026-08-14）。言い換えない。
 */
function NotSharedYet({ listId, onClose }: { listId: string; onClose: () => void }) {
  return (
    <>
      <h2 id="share-invite-title" className="text-center text-lg font-bold">
        みんなにもリストを見せませんか？
      </h2>

      <p className="mt-3 text-sm leading-6 text-slate-600">
        いまは自分だけが見られる状態です。公開すると、リンクを渡した人に見てもらえます。
      </p>

      <Link
        href={`/lists/${listId}/share`}
        onClick={onClose}
        className="mt-5 block rounded-lg bg-brand-deep px-3 py-3 text-center font-bold text-white"
      >
        共有の設定を開く
      </Link>

      <CloseButton onClose={onClose} />
    </>
  )
}

/**
 * もう公開しているとき。**設定画面へ回さず、その場で送れるようにする**
 * （2026-08-14 の利用者の指示）。
 */
function AlreadyShared({ shareId, onClose }: { shareId: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const url = shareUrl(window.location.origin, shareId)

  const share = async () => {
    setFailed(null)

    try {
      await navigator.share({ url })
    } catch (error) {
      // 🔴 **閉じただけなら何も出さない**（#275 と同じ判断）
      if (isShareCancelled(error)) return

      setFailed('共有できませんでした。URL をコピーして渡してください')
    }
  }

  const copy = async () => {
    setFailed(null)

    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setFailed('コピーできませんでした。共有の設定から URL を選んでコピーしてください')
    }
  }

  return (
    <>
      <h2 id="share-invite-title" className="text-center text-lg font-bold">
        SNSでみんなに見せませんか？
      </h2>

      <p className="mt-3 text-sm leading-6 text-slate-600">
        このリストは、リンクを渡した人が見られる状態です。
      </p>

      {failed !== null && (
        <p role="alert" className="mt-3 text-sm text-brand-deep">
          {failed}
        </p>
      )}

      {/* 🔴 **共有シートが使えるときだけ出す**（#275 と同じ。押せて何も起きないボタンを作らない） */}
      {canUseShareSheet(navigator) && (
        <button
          type="button"
          onClick={() => void share()}
          className="mt-5 w-full rounded-lg bg-brand-deep px-3 py-3 font-bold text-white"
        >
          共有する
        </button>
      )}

      <button
        type="button"
        onClick={() => void copy()}
        className={
          canUseShareSheet(navigator)
            ? 'mt-2 w-full rounded-lg border border-brand-deep px-3 py-3 font-bold text-brand-deep'
            : 'mt-5 w-full rounded-lg bg-brand-deep px-3 py-3 font-bold text-white'
        }
      >
        {copied ? 'コピーしました' : 'URL をコピー'}
      </button>

      <CloseButton onClose={onClose} />
    </>
  )
}

/** 断る側。**主のボタンと同じ強さにしない。** */
function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} className="mt-3 w-full py-2 text-sm text-slate-500">
      閉じる
    </button>
  )
}
