import { SERVICE_NAME } from '@yaritai100list/shared'
import { useEffect, useState } from 'react'

import { api } from './api'

/**
 * 土台の確認用の画面。リストの UI は #4 で作る。
 *
 * ここで確かめているのは3つ:
 * - SPA が Workers から配信されること
 * - 同一オリジンで API を呼べること（CORS の設定が要らないこと）
 * - **Hono RPC でサーバーの型がクライアントに流れること**
 */
export function App() {
  const [health, setHealth] = useState<string>('確認中')

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

  return (
    <main>
      <h1>{SERVICE_NAME}</h1>
      <p>API: {health}</p>
    </main>
  )
}
