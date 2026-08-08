import { SERVICE_NAME } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link, Route, Switch, useLocation } from 'wouter'

import { ExportPage } from './ExportPage'
import { ListPage } from './ListPage'
import { ListsPage } from './ListsPage'
import { SharePage } from './SharePage'
import { Notice } from './Notice'
import { signOutRequestInit, toSessionState, type SessionState } from './model'

/**
 * 画面の入口。**ここに残すのは全画面で共通の枠と、セッションの取得だけ。**
 *
 * ルーティングは wouter（`TECH_STACK.md` §10 の決定）。
 * 画面のパスは Worker に通していない（`wrangler.jsonc` の `run_worker_first` は
 * `/api/*` だけ）。静的ファイルに当たらないパスは
 * `not_found_handling: single-page-application` が index.html を返すので、
 * **`/lists/xxx` を直接開いてもこの SPA が起動する。**
 */
export function App() {
  const [, navigate] = useLocation()
  const [session, setSession] = useState<SessionState>({ status: 'loading' })
  const [signOutFailed, setSignOutFailed] = useState(false)

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

    // 🔴 **トップへ戻す**（#112）。ログインが要る画面に残ると、
    // 直前まで見えていたものが消えたように見える
    navigate('/')
  }, [loadSession, navigate])

  return (
    <div className="min-h-dvh bg-brand-soft">
      {/*
        モバイル縦1カラムを主対象にする（PRODUCT_SPEC.md §4.5）。
        広い画面では中央に寄せるだけで、**列は増やさない。**

        🔴 **幅を決めるのはここ1箇所。** 画面ごとに別の幅を書かない（#143）。

        `max-w-xl`（36rem）。`max-w-md`（28rem）では項目の入力欄が窮屈だった。
        ⚠️ **効くのは広い画面だけ。** よくある電話の横幅（約 24rem）は
        どちらの上限より狭いので、モバイルの見え方は変わらない
      */}
      <div className="mx-auto max-w-xl px-4 pb-24">
        <header className="-mx-4 mb-4 flex items-baseline justify-between bg-brand px-4 py-3">
          <Link href="/" className="text-xs font-bold text-slate-900">
            {SERVICE_NAME}
          </Link>

          {/* 未ログインで持てるリストは1つだけなので、一覧への導線を出さない */}
          {session.status === 'authenticated' && (
            <Link href="/lists" className="text-xs text-slate-900 underline">
              すべてのリスト
            </Link>
          )}
        </header>

        <SessionArea session={session} onRetry={() => void loadSession()} />

        <Switch>
          {/* トップは一覧ではなく**最後に更新したリスト**（PRODUCT_SPEC.md §4.3）。
              リストを1つしか持っていない人に無駄な1タップを作らない */}
          <Route path="/">
            <ListPage session={session} />
          </Route>

          <Route path="/lists">
            {/* ログアウトはここに置く。日常的に押すものではないので、
                編集画面には出さない（#114） */}
            <ListsPage
              session={session}
              signOutFailed={signOutFailed}
              onSignOut={() => void signOut()}
            />
          </Route>

          {/* :listId より先に置かなくても段数が違うので当たらないが、
              関係のある経路を近くに並べておく */}
          <Route path="/lists/:listId/export">
            {(params) => <ExportPage session={session} listId={params.listId} />}
          </Route>

          <Route path="/lists/:listId/share">
            {(params) => <SharePage session={session} listId={params.listId} />}
          </Route>

          <Route path="/lists/:listId">
            {(params) => <ListPage session={session} listId={params.listId} />}
          </Route>

          <Route>
            <Notice tone="warn">
              このページはありません。
              <Link href="/" className="underline">
                トップへ戻る
              </Link>
            </Notice>
          </Route>
        </Switch>
      </div>
    </div>
  )
}

/**
 * ログイン状態の表示。**ログアウトのボタンはここに置かない**（#114）。
 *
 * 日常的に押すものではないうえ、編集画面から誤って押すと
 * リストが消えたように見える。置き場所は `/lists` の一番下。
 */
function SessionArea({ session, onRetry }: { session: SessionState; onRetry: () => void }) {
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

      {session.status === 'authenticated' && <p>ログイン中</p>}
    </div>
  )
}
