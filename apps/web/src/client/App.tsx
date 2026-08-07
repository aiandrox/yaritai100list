import {
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
  SERVICE_NAME,
} from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'

import { ListEditor } from './ListEditor'
import {
  signOutRequestInit,
  toCompletionPermission,
  toSessionState,
  type SessionState,
} from './model'
import { useList, type ImportOutcome, type ListController, type Rejection } from './useList'

/**
 * 画面の入口。
 *
 * **判定と変換は `model.ts` の純関数**（`TECH_STACK.md` §10）、
 * **読み書きの配線は `useList.ts`**。ここに残すのは描画と、セッションの取得だけ。
 */

/**
 * 断られた理由ごとの文言。
 *
 * 🔴 **「空」と「長すぎ」を同じ文言にしない**（#79 で実際に踏んだ）。
 * 長すぎて弾かれた人に「1文字以上入力してください」と出しても、何を直せばいいのか
 * 分からない。文字数は `packages/shared` の定数から出す（ここに数字を書かない）。
 */
const REJECTION_MESSAGES: Record<Rejection, string> = {
  'text-empty': 'やりたいことを入力してください',
  'text-too-long': `やりたいことは${String(ITEM_TEXT_MAX_LENGTH)}文字までです`,
  'title-empty': 'タイトルを入力してください',
  'title-too-long': `タイトルは${String(LIST_TITLE_MAX_LENGTH)}文字までです`,
  'list-full': `${String(ITEMS_PER_LIST_MAX)}件まで書けます。減らすと続けて書けます`,
  'not-found': '対象の項目が見つかりませんでした',
  'server-error': '保存できませんでした。通信を確かめて、もう一度試してください',
}

export function App() {
  const [session, setSession] = useState<SessionState>({ status: 'loading' })
  const [signOutFailed, setSignOutFailed] = useState(false)

  const controller = useList(session)

  // --- セッション（#3 で入れた配線。消さないこと） ---

  const loadSession = useCallback(async () => {
    setSession({ status: 'loading' })

    try {
      // Better Auth のエンドポイントは Hono RPC の型に乗らないので普通の fetch で呼ぶ
      const res = await fetch('/api/auth/get-session')
      const body: unknown = await res.json()

      setSession(toSessionState({ ok: res.ok, body }))
    } catch {
      // 通信自体が失敗した場合（オフラインなど）。未ログインと区別する
      setSession({ status: 'error' })
    }
  }, [])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  const signOut = useCallback(async () => {
    setSignOutFailed(false)

    // 要求の中身は model.ts に置いている（content-type と本文が要る理由もそこ）
    const res = await fetch('/api/auth/sign-out', signOutRequestInit())

    // **失敗を黙って飲まない。** ここで状態を取り直すと画面は「ログイン中」に
    // 戻るだけなので、利用者にはログアウトできたのか判断がつかない
    if (!res.ok) setSignOutFailed(true)

    // サーバー側でセッションを消したので、状態を取り直す
    await loadSession()
  }, [loadSession])

  const { screen, rejection } = controller

  return (
    <div className="min-h-dvh bg-brand-soft">
      {/* モバイル縦1カラムを主対象にする（PRODUCT_SPEC.md §4.5）。
          広い画面では中央に寄せるだけで、列は増やさない */}
      <div className="mx-auto max-w-md px-4 pb-24">
        <header className="-mx-4 mb-4 bg-brand px-4 py-3">
          <p className="text-xs font-bold text-slate-900">{SERVICE_NAME}</p>
        </header>

        <SessionArea
          session={session}
          signOutFailed={signOutFailed}
          onRetry={() => void loadSession()}
          onSignOut={() => void signOut()}
        />

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

            {rejection !== null && (
              <p role="alert" className="mb-2 rounded bg-white px-3 py-2 text-sm text-brand-deep">
                {REJECTION_MESSAGES[rejection]}
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
              onRemoveItem={controller.removeItem}
            />
          </>
        )}
      </div>
    </div>
  )
}

function SessionArea({
  session,
  signOutFailed,
  onRetry,
  onSignOut,
}: {
  session: SessionState
  signOutFailed: boolean
  onRetry: () => void
  onSignOut: () => void
}) {
  return (
    <div className="mb-2 text-right text-xs text-slate-600">
      {session.status === 'error' && (
        <p>
          ログイン状態を確認できませんでした{' '}
          <button type="button" onClick={onRetry} className="underline">
            再試行
          </button>
        </p>
      )}

      {session.status === 'authenticated' && (
        <p>
          ログイン中{' '}
          <button type="button" onClick={onSignOut} className="underline">
            ログアウト
          </button>
        </p>
      )}

      {signOutFailed && <p className="text-brand-deep">ログアウトに失敗しました</p>}
    </div>
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
        ずっと残したい方はログインしてください
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

function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  return (
    <p
      className={`mb-3 rounded px-3 py-2 text-xs ${
        tone === 'warn' ? 'bg-white text-brand-deep' : 'bg-white/70 text-slate-600'
      }`}
    >
      {children}
    </p>
  )
}
