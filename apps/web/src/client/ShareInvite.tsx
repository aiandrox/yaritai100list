import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'

import { Modal } from './Modal'
import {
  achievementTitle,
  canUseShareSheet,
  isShareCancelled,
  shareUrl,
  type Achievement,
} from './model'
import type { ShareState } from './useList'

/**
 * 叶えたとき・100個書き終えたときに出す、共有へのお誘い（#276）。
 *
 * **人が貼りたくなるのは、空のリストではなく達成したとき。**
 * それまでの導線は「共有の設定を開く → 公開範囲を変える → URL をコピー」だけで、
 * **一番気分が乗っている瞬間には何も起きなかった。**
 *
 * 🔴 **見出しは「何が起きたか」**（2026-08-15 の利用者の指摘、#306）。
 * 「〈やりたいこと〉を達成しました」「100個、書き終わりました！」。
 * 以前は共有の話から始まっていて、**なぜ出たのか分からなかった**
 * （押し間違いで出た広告のように見える）。文言は `model.ts` の `achievementTitle`。
 *
 * 🔴 **公開範囲で中身を変える**（2026-08-14 の利用者の指示）。いまの状態から次の一歩が違う。
 *
 * | いまの公開範囲 | 出すもの |
 * |---|---|
 * | 非公開 | 「みんなにもリストを見せませんか？」→ 共有の設定へ |
 * | 全公開・リンク限定 | 「SNSでみんなに見せませんか？」→ **その場で送れる** |
 *
 * ⚠️ **この2つの文は本文の先頭に移した**（#306）。見出しを達成の報告に譲ったため。
 * **文言は変えていない**（#276 で利用者が書いたもの）。
 *
 * 🔴 **ここで公開範囲を変えられるようにしない。** 誘いの場で設定を触らせない。
 *
 * ⚠️ **出すかどうかを決めるのはここではない**（`ListPage`）。
 * ここは「開けと言われたら開く」だけ。判断は `model.ts` の純関数に置いてある。
 */

/**
 * 枠は `Modal.tsx`（#282）。**`<dialog>` の作法はそちらに寄せてある。**
 * ここが決めるのは中身と、開くきっかけだけ。
 */
export function ShareInvite({
  listId,
  share,
  achievement,
  onClose,
}: {
  listId: string
  share: ShareState
  /** 何が起きて出たのか（#306）。**見出しになる** */
  achievement: Achievement
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = () => dialog.current?.close()

  // 出すときだけ組み立てられる（`ListPage`）ので、置かれたら開く
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <Modal ref={dialog} title={achievementTitle(achievement)} onClose={onClose}>
      {share.visibility === 'private' ? (
        <NotSharedYet listId={listId} onClose={close} />
      ) : (
        <AlreadyShared shareId={share.shareId} />
      )}
    </Modal>
  )
}

/**
 * 共有を促す文。
 *
 * 🔴 **利用者が書いた文をそのまま使う**（2026-08-14）。言い換えない。
 * #306 で**見出しから本文の先頭へ移した**（見出しは達成の報告になった）。
 */
const INVITE_LEAD = 'みんなにもリストを見せませんか？'
const SHARE_LEAD = 'SNSでみんなに見せませんか？'

/**
 * まだ非公開のとき。**渡す先が無いので、まず公開範囲を決めてもらう。**
 */
function NotSharedYet({ listId, onClose }: { listId: string; onClose: () => void }) {
  return (
    <>
      {/* 🔴 **共有を促すのはここから**（#306）。見出しは達成の報告 */}
      <p className="mt-3 text-center text-sm font-bold">{INVITE_LEAD}</p>

      <p className="mt-2 text-sm leading-6 text-slate-600">
        いまは自分だけが見られる状態です。公開すると、リンクを渡した人に見てもらえます。
      </p>

      <Link
        href={`/lists/${listId}/share`}
        onClick={onClose}
        className="mt-5 block rounded-lg bg-brand-deep px-3 py-3 text-center font-bold text-white"
      >
        共有の設定を開く
      </Link>
    </>
  )
}

/**
 * もう公開しているとき。**設定画面へ回さず、その場で送れるようにする**
 * （2026-08-14 の利用者の指示）。
 */
function AlreadyShared({ shareId }: { shareId: string }) {
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
      <p className="mt-3 text-center text-sm font-bold">{SHARE_LEAD}</p>

      <p className="mt-2 text-sm leading-6 text-slate-600">
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
    </>
  )
}
