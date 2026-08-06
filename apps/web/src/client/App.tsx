import { SERVICE_NAME } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'

import { api } from './api'

/** ログイン状態。判定中と未ログインを区別する（未ログインのときだけ導線を出すため） */
type SessionState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated' }

/**
 * 土台の確認用の画面。リストの UI は #4 で作る。
 *
 * ロジックを純関数に切り出すのは #4 から（`TECH_STACK.md` §10 の方針）。
 * ここにあるのはセッションの取得とログアウトの呼び出しだけで、切り出す中身が無い。
 */
export function App() {
  const [health, setHealth] = useState('確認中')
  const [session, setSession] = useState<SessionState>({ status: 'loading' })

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
    // Better Auth のエンドポイントは Hono RPC の型に乗らないので普通の fetch で呼ぶ
    const res = await fetch('/api/auth/get-session')
    const body: unknown = await res.json()

    setSession({ status: body === null ? 'anonymous' : 'authenticated' })
  }, [])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  const signOut = useCallback(async () => {
    await fetch('/api/auth/sign-out', { method: 'POST' })

    // サーバー側でセッションを消したので、状態を取り直す
    await loadSession()
  }, [loadSession])

  return (
    <main>
      <h1>{SERVICE_NAME}</h1>
      <p>API: {health}</p>

      {session.status === 'loading' && <p>読み込み中</p>}

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
    </main>
  )
}
