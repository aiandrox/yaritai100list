import { SERVICE_NAME } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'

import { ListEditor } from './ListEditor'
import {
  addItem,
  createEmptyList,
  LIST_STORAGE_KEY,
  parseStoredList,
  removeItem,
  renameList,
  serializeList,
  setItemCompletedAt,
  signOutRequestInit,
  toCompletionPermission,
  toSessionState,
  updateItemText,
  type Item,
  type ListResult,
  type LocalList,
  type SessionState,
} from './model'

/**
 * 未ログインでも書ける画面（#4）。
 *
 * **判定と計算は `model.ts` の純関数に置く**（`TECH_STACK.md` §10 の方針）。
 * ここに残すのは、localStorage との読み書き・取得の配線・描画だけ。
 */

/**
 * 保存の状態。**「読めなかった」を「まだ何も無い」に混ぜない。**
 *
 * 混ぜると、読めなかっただけの保存に空リストを上書きして
 * 利用者の書いたものを消す（`parseStoredList` の注意書きと同じ話）。
 */
type StorageState =
  | { status: 'loading' }
  | { status: 'ok' }
  /** 保存はあるが読めない。**利用者が了解するまで書き込まない。** */
  | { status: 'broken' }
  /** localStorage 自体が使えない（プライベートブラウズなど）。書けるが残らない。 */
  | { status: 'unavailable' }
  /** 書き込みに失敗した（容量など）。**黙って失敗しない。** */
  | { status: 'save-failed' }

const ERROR_MESSAGES = {
  'invalid-text': 'やりたいことは1文字以上で入力してください',
  'invalid-title': 'タイトルは1文字以上で入力してください',
  'list-full': '100件まで書けます。減らすと続けて書けます',
  'not-found': '対象の項目が見つかりませんでした',
} as const

export function App() {
  const [session, setSession] = useState<SessionState>({ status: 'loading' })
  const [signOutFailed, setSignOutFailed] = useState(false)

  const [list, setList] = useState<LocalList | null>(null)
  const [storage, setStorage] = useState<StorageState>({ status: 'loading' })
  const [error, setError] = useState<string | null>(null)

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

  // --- localStorage ---

  useEffect(() => {
    let raw: string | null

    try {
      raw = window.localStorage.getItem(LIST_STORAGE_KEY)
    } catch {
      // 保存できないだけで、書くことはできる。空のリストで始める
      setList(createEmptyList())
      setStorage({ status: 'unavailable' })
      return
    }

    const stored = parseStoredList(raw)

    if (stored.status === 'broken') {
      // **リストを作らない。** 作ると最初の編集で保存を上書きしてしまう
      setStorage({ status: 'broken' })
      return
    }

    setList(stored.status === 'loaded' ? stored.list : createEmptyList())
    setStorage({ status: 'ok' })
  }, [])

  /**
   * 変更を反映して保存する。**保存は変更のたびにここだけで行う。**
   *
   * `useEffect` で `list` を監視して保存すると、読み込み直後にも走るため、
   * 「読めなかった保存」を上書きする経路ができてしまう。
   */
  const applyResult = useCallback(
    (result: ListResult): boolean => {
      if (!result.ok) {
        setError(ERROR_MESSAGES[result.reason])
        return false
      }

      setError(null)
      setList(result.list)

      if (storage.status === 'unavailable') return true

      try {
        window.localStorage.setItem(LIST_STORAGE_KEY, serializeList(result.list))
        setStorage({ status: 'ok' })
      } catch {
        setStorage({ status: 'save-failed' })
      }

      return true
    },
    [storage.status],
  )

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

        {storage.status === 'loading' && <p className="py-8 text-slate-500">読み込み中</p>}

        {storage.status === 'broken' && (
          <BrokenStorageNotice
            onStartOver={() => {
              // ここでは保存を消さない。最初の編集で上書きされる
              setList(createEmptyList())
              setStorage({ status: 'ok' })
            }}
          />
        )}

        {list && (
          <>
            <StorageNotice storage={storage} session={session} />

            {error !== null && (
              <p role="alert" className="mb-2 rounded bg-white px-3 py-2 text-sm text-brand-deep">
                {error}
              </p>
            )}

            <ListEditor
              list={list}
              // 未ログインでは「叶えた」印を付けられない（PRODUCT_SPEC.md §2）。
              // 判定は model.ts の純関数。ここでは status を見比べない
              completion={toCompletionPermission(session)}
              onRenameList={(title) => applyResult(renameList(list, title))}
              onAddItem={(text) => applyResult(addItem(list, { id: crypto.randomUUID(), text }))}
              onUpdateItemText={(id, text) => applyResult(updateItemText(list, id, text))}
              onToggleItem={(item: Item) => {
                // 案内を出すのは ListEditor だが、**印を付けない判断はここでもする。**
                // 配線を間違えたときに、黙って未ログインの完了が保存される方が重い
                if (!toCompletionPermission(session).allowed) return

                // 完了日時は**呼び出し側で作る**（model.ts に時計を持ち込まない）
                applyResult(
                  setItemCompletedAt(list, item.id, item.completedAt === null ? Date.now() : null),
                )
              }}
              onRemoveItem={(id) => {
                applyResult(removeItem(list, id))
              }}
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
 * 「保存されていない可能性がある」ことを伝える導線（`PRODUCT_SPEC.md` §4.1）。
 *
 * ログインの動機付けなので、**未ログインのときだけログインの入口を出す。**
 * ログイン済みでもいまは localStorage にしか保存していない（サーバーへの保存は #5）。
 */
function StorageNotice({ storage, session }: { storage: StorageState; session: SessionState }) {
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

  return (
    <Notice tone="info">
      いまはこのブラウザにだけ保存されています。端末を変えると見られません
      {session.status === 'anonymous' && (
        <>
          {' '}
          {/* ログインの開始は POST なので <a> から叩けない。
              サーバー側に GET の入口を用意している（/api/login/google） */}
          <a href="/api/login/google" className="font-bold text-brand-deep underline">
            Google でログイン
          </a>
        </>
      )}
    </Notice>
  )
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
