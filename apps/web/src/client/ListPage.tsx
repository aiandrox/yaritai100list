import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'

import { ListEditor } from './ListEditor'
import { Notice } from './Notice'
import { ShareInvite } from './ShareInvite'
import { SignInBenefits } from './SignInBenefits'
import {
  canInviteToShare,
  listProgress,
  parseInvitedAt,
  rejectionMessage,
  shareInviteStorageKey,
  shareInviteTrigger,
  toCompletionPermission,
  type ListProgress,
  type SessionState,
} from './model'
import { useList, type ImportOutcome, type ListController } from './useList'

/**
 * リスト1つを編集する画面。`/` と `/lists/:listId` の両方で使う。
 *
 * `listId` を渡さなければ**最後に更新したリスト**を開く（`PRODUCT_SPEC.md` §4.3）。
 * 読み書きの配線は `useList.ts`、判定と変換は `model.ts` の純関数。
 */

export function ListPage({ session, listId }: { session: SessionState; listId?: string }) {
  // 🔴 **`/lists/:listId` は未ログインでは開かせない**（#112）。
  // 素通しすると、URL が指すリストではなく**ブラウザに保存した内容**が出てしまい、
  // URL と画面の中身が食い違う。
  //
  // `useList` を呼ぶ前に返す。呼んでしまうと localStorage を読みに行く
  if (listId !== undefined && session.status !== 'authenticated') {
    return <SignInRequired session={session} />
  }

  return <ListPageBody session={session} listId={listId} />
}

/**
 * ログインが要る画面に未ログインで来たとき。
 *
 * **`error`（確認できない）を未ログインと同じ文言にしない。**
 * ログイン済みの人にログインを促すことになる（`toCompletionPermission` と同じ考え方）。
 */
function SignInRequired({ session }: { session: SessionState }) {
  if (session.status === 'loading') return <p className="py-8 text-slate-500">読み込み中</p>

  if (session.status === 'error') {
    return (
      <Notice tone="warn">
        ログイン状態を確認できないため、このリストを開けません。通信を確かめてください
      </Notice>
    )
  }

  return (
    <Notice tone="info">
      このリストを見るには
      <a href="/api/login/google" className="font-bold text-brand-deep underline">
        Googleでログイン
      </a>
      してください
    </Notice>
  )
}

/**
 * 共有のお誘いを出すかどうかを決める（#276）。
 *
 * 🔴 **操作の側に手を入れない。** 「✓ を押したとき」「項目を足したとき」に
 * 呼び出しを足す形にすると、**足し忘れた経路から出なくなる**し、
 * 楽観更新の巻き戻しまで拾ってしまう。
 * ここでは**進み具合の変化だけを見る**（増えたときだけ誘う）。
 *
 * ⚠️ **別のリストに切り替わった直後は比べない。** 数が飛ぶので、
 * 開いただけで誘いが出る。
 */
function useShareInvite(screen: ListController['screen']): {
  open: boolean
  close: () => void
} {
  const [open, setOpen] = useState(false)
  const previous = useRef<{ key: string; progress: ListProgress } | null>(null)

  const key = screen.status === 'ready' ? screen.key : null
  const list = screen.status === 'ready' ? screen.list : null
  // 未ログイン（`share` が null）では誘わない。渡す先がログインの向こう側にある
  const shared = screen.status === 'ready' && screen.share !== null

  useEffect(() => {
    if (key === null || list === null || !shared) {
      previous.current = null
      return
    }

    const progress = listProgress(list)
    const before = previous.current
    previous.current = { key, progress }

    if (before?.key !== key) return
    if (shareInviteTrigger(before.progress, progress) === null) return

    /*
     * 🔴 **間隔を守る**（同じリストでは30日に1回）。
     *
     * ⚠️ **localStorage が使えないときは出さない。** 出した記録を残せないので、
     * **叶えるたびに毎回出る**ことになる。静かな方に倒す
     */
    try {
      const storageKey = shareInviteStorageKey(key)
      const now = Date.now()

      if (!canInviteToShare({ invitedAt: parseInvitedAt(localStorage.getItem(storageKey)), now })) {
        return
      }

      localStorage.setItem(storageKey, String(now))
      setOpen(true)
    } catch {
      // 記録できない環境。**黙って出さない**（利用者に伝えることが無い）
    }
  }, [key, list, shared])

  return {
    open,
    close: () => {
      setOpen(false)
    },
  }
}

function ListPageBody({
  session,
  listId,
}: {
  session: SessionState
  // exactOptionalPropertyTypes が有効なので、渡す側に合わせて undefined を明示する
  listId: string | undefined
}) {
  const controller = useList(session, listId ?? null)
  const { screen, rejection } = controller
  const invite = useShareInvite(screen)

  return (
    <>
      <ImportNotice outcome={controller.importOutcome} />

      {screen.status === 'loading' && <p className="py-8 text-slate-500">読み込み中</p>}

      {screen.status === 'broken' && <BrokenStorageNotice onStartOver={controller.startOver} />}

      {screen.status === 'failed' && (
        <Notice tone="warn">
          リストを読み込めませんでした。書き換えて失わないよう、編集を止めています。
          通信を確かめて、ページを開き直してください
        </Notice>
      )}

      {screen.status === 'ready' && (
        <>
          <StorageNotice controller={controller} session={session} />

          {/*
            共有への導線（#153）。**`/` でも出す。**
            開いているリストの ID は `screen.key`（サーバーのときは `listId`）。

            未ログイン（`source === 'local'`）では出さない。共有はログインが要る
          */}
          {screen.source === 'server' && (
            <p className="mb-2 flex justify-end gap-3">
              <Link
                href={`/lists/${screen.key}/share`}
                className="text-xs text-brand-deep underline"
              >
                共有の設定
              </Link>
              {/* 🔴 **入口をここに揃える**（#202）。共有だけここ、書き出しは一覧、
                  という状態になっていた。同じ階層のものは同じ場所から行けるようにする */}
              <Link
                href={`/lists/${screen.key}/export`}
                className="text-xs text-brand-deep underline"
              >
                書き出す
              </Link>
            </p>
          )}

          {rejection !== null && (
            <p role="alert" className="mb-2 rounded bg-white px-3 py-2 text-sm text-brand-deep">
              {rejectionMessage(rejection)}
            </p>
          )}

          <ListEditor
            // 🔴 **開いているリストが変われば作り直す**（#102）。
            // 入力欄の下書きは各コンポーネントが持っているので、
            // 作り直さないと**ログアウトしても前のタイトルが残る**
            key={screen.key}
            list={screen.list}
            // 未ログインでは「やった」印を付けられない（PRODUCT_SPEC.md §2）。
            // 判定は model.ts の純関数。ここでは status を見比べない
            completion={toCompletionPermission(session)}
            onRenameList={controller.renameList}
            onAddItem={controller.addItem}
            onUpdateItemText={controller.updateItemText}
            onToggleItem={controller.toggleItem}
            onChangeCompletedAt={controller.changeCompletedAt}
            onRemoveItem={controller.removeItem}
            onMoveItem={controller.moveItem}
          />

          {/*
            叶えたとき・100個書き終えたときのお誘い（#276）。
            **出すかどうかは `useShareInvite`。** ここは置き場所だけ
          */}
          {screen.share !== null && (
            <ShareInvite
              listId={screen.key}
              share={screen.share}
              open={invite.open}
              onClose={invite.close}
            />
          )}
        </>
      )}
    </>
  )
}

/**
 * ブラウザに書いていた内容を取り込めたかの案内（`PRODUCT_SPEC.md` §2）。
 *
 * 🔴 **取り込めなかったことを黙らない。** ブラウザ側のデータは消していないので、
 * リストを整理すれば取り込める、と分かるようにする。
 */
function ImportNotice({ outcome }: { outcome: ImportOutcome }) {
  if (outcome === 'imported') {
    return (
      <Notice tone="info">このブラウザに書いていた内容を、新しいリストとして取り込みました</Notice>
    )
  }

  if (outcome === 'limit-reached') {
    return (
      <Notice tone="warn">
        リストの数が上限のため、このブラウザに書いていた内容を取り込めませんでした。
        内容はこのブラウザに残してあります。リストを整理してから開き直すと取り込めます
      </Notice>
    )
  }

  return null
}

/**
 * どこに保存されているかの案内。
 *
 * ログイン中は**サーバーに保存されている**ので、ログインを促さない。
 */
function StorageNotice({
  controller,
  session,
}: {
  controller: ListController
  session: SessionState
}) {
  const { screen, storage } = controller

  if (screen.status === 'ready' && screen.source === 'server') return null

  if (storage.status === 'unavailable') {
    return (
      <Notice tone="warn">
        このブラウザでは保存できない設定です。閉じると書いた内容は消えます
      </Notice>
    )
  }

  if (storage.status === 'save-failed') {
    return <Notice tone="warn">保存できませんでした。書いた内容が残らないおそれがあります</Notice>
  }

  if (session.status === 'anonymous') {
    return (
      <Notice tone="info">
        {/* ログインの開始は POST なので <a> から叩けない。
            サーバー側に GET の入口を用意している（/api/login/google） */}
        <a href="/api/login/google" className="font-bold text-brand-deep underline">
          Googleでログイン
        </a>
        すると、保存したリストを見られます。端末を変えても見られるので、
        ずっと残したい方はログインしてください。 <SignInBenefits />
      </Notice>
    )
  }

  return <Notice tone="info">いまはこのブラウザにだけ保存されています</Notice>
}

function BrokenStorageNotice({ onStartOver }: { onStartOver: () => void }) {
  return (
    <div className="rounded bg-white px-3 py-3 text-sm text-slate-700">
      <p className="font-bold text-brand-deep">保存されていた内容を読み込めませんでした</p>
      <p className="mt-1">
        壊れた内容を勝手に消さないよう、編集を止めています。
        新しく書き始めると、次に書いた時点で保存が置き換わります。
      </p>
      <button
        type="button"
        onClick={onStartOver}
        className="mt-2 rounded bg-brand-deep px-3 py-1.5 text-white"
      >
        新しく書き始める
      </button>
    </div>
  )
}
