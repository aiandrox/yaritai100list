import { SERVICE_NAME } from '@yaritai100list/shared'
import { useEffect, useState } from 'react'

import { api } from './api'

/**
 * 土台の確認用の画面。リストの UI は #4 で作る。
 *
 * ここで確かめているのは:
 * - SPA が Workers から配信されること
 * - 同一オリジンで API を呼べること（CORS の設定が要らないこと）
 * - **Hono RPC でサーバーの型がクライアントに流れること**
 * - ログインが通ること（ログアウトと状態表示は #53 で作る）
 */
export function App() {
  const [health, setHealth] = useState<string>('確認中')
  const [session, setSession] = useState<string>('確認中')

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

  useEffect(() => {
    const check = async () => {
      // Better Auth のエンドポイントは Hono RPC の型に乗らないので普通の fetch で呼ぶ
      const res = await fetch('/api/auth/get-session')
      const body: unknown = await res.json()

      setSession(body === null ? '未ログイン' : 'ログイン中')
    }

    void check()
  }, [])

  return (
    <main>
      <h1>{SERVICE_NAME}</h1>
      <p>API: {health}</p>
      <p>セッション: {session}</p>
      {/*
        Better Auth の sign-in は POST なので、`<a>` から叩ける GET の入口を
        サーバー側に用意している（`/api/login/google`）。
        ボタンの見た目とログアウトは #53 で作る。
      */}
      <p>
        <a href="/api/login/google">Google でログイン</a>
      </p>
    </main>
  )
}
