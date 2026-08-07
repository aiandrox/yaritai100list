import { LISTS_PER_USER_MAX } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import { formatItemNumber, sortListsByUpdated, type RemoteList, type SessionState } from './model'

/**
 * マイリストの一覧（`PRODUCT_SPEC.md` §4.3）。
 *
 * ここは**切り替えと管理のための画面**。トップ（`/`）は一覧ではなく
 * 最後に更新したリストを直接出す（リストが1つしかない人に無駄な操作を作らない）。
 *
 * 作成 / タイトル変更 / 削除は #101 で足す。
 */

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; lists: RemoteList[] }

export function ListsPage({ session }: { session: SessionState }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  const load = useCallback(async () => {
    try {
      const res = await api.api.lists.$get()
      if (!res.ok) {
        setState({ status: 'failed' })
        return
      }

      const { lists } = await res.json()
      setState({ status: 'ready', lists: sortListsByUpdated(lists) })
    } catch {
      setState({ status: 'failed' })
    }
  }, [])

  useEffect(() => {
    if (session.status !== 'authenticated') return

    void load()
  }, [session.status, load])

  // 未ログインで持てるリストは1つだけなので、一覧という概念が無い（PRODUCT_SPEC.md §2）
  if (session.status !== 'authenticated') {
    return (
      <Notice tone="info">
        <a href="/api/login/google" className="font-bold text-brand-deep underline">
          Googleでログイン
        </a>
        すると、リストを{LISTS_PER_USER_MAX}つまで持てます。
        「2026年にやりたいこと」のような使い分けができます
      </Notice>
    )
  }

  if (state.status === 'loading') return <p className="py-8 text-slate-500">読み込み中</p>

  if (state.status === 'failed') {
    return <Notice tone="warn">リストを読み込めませんでした。通信を確かめてください</Notice>
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-900">マイリスト</h1>
      <p className="mt-1 text-xs text-slate-500">
        {state.lists.length} / {LISTS_PER_USER_MAX}
      </p>

      <ul className="mt-4">
        {state.lists.map((list, index) => (
          <li key={list.id} className="border-b border-brand/40">
            <Link
              href={`/lists/${list.id}`}
              className="flex items-center gap-2 py-3 text-slate-900"
            >
              <span className="w-8 shrink-0 text-right text-xs text-slate-500 tabular-nums">
                {formatItemNumber(index + 1)}
              </span>
              <span className="min-w-0 flex-1 truncate">{list.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
