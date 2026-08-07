import { SERVICE_NAME } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'

import { api } from './api'
import { signOutRequestInit, toSessionState, type SessionState } from './model'

/**
 * 土台の確認用の画面。リストの UI は #4 で作る。
 *
 * **状態の判定は `model.ts` の純関数に置く**（`TECH_STACK.md` §10 の方針）。
 * ここに残すのは取得と描画の配線だけ。
 */
export function App() {
  const [health, setHealth] = useState('確認中')
  const [session, setSession] = useState<SessionState>({ status: 'loading' })
  const [signOutFailed, setSignOutFailed] = useState(false)

  useEffect(() => {
    const check = async () => {
      const res = await api.api.health.$get()
      const data = await res.json()

      // data.status は サーバーの `c.json({ status: 'ok' } as const)` から
      // 型が流れてきている。サーバー側を変えるとここが型エラーになる
      setHealth(data.status)
    }

    void check()
  }, [])

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

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="text-xl font-bold">{SERVICE_NAME}</h1>
      <p>API: {health}</p>

      {session.status === 'loading' && <p>読み込み中</p>}

      {session.status === 'error' && (
        <p>
          ログイン状態を確認できませんでした{' '}
          <button type="button" onClick={() => void loadSession()}>
            再試行
          </button>
        </p>
      )}

      {/*
        ログインの開始は POST なので `<a>` から叩けない。
        サーバー側に GET の入口を用意している（`/api/login/google`）
      */}
      {session.status === 'anonymous' && (
        <p>
          <a href="/api/login/google">Google でログイン</a>
        </p>
      )}

      {session.status === 'authenticated' && (
        <p>
          ログイン中{' '}
          <button type="button" onClick={() => void signOut()}>
            ログアウト
          </button>
        </p>
      )}

      {signOutFailed && <p>ログアウトに失敗しました。時間をおいて試してください</p>}
    </main>
  )
}
