import { LISTS_PER_USER_MAX, LIST_TITLE_MAX_LENGTH } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import {
  formatItemNumber,
  hasAnythingToImport,
  LIST_STORAGE_KEY,
  parseStoredList,
  sortListsByUpdated,
  toImportBody,
  type LocalList,
  type RemoteList,
  type SessionState,
} from './model'

/**
 * マイリストの一覧（`PRODUCT_SPEC.md` §4.3）。
 *
 * ここは**切り替えと管理のための画面**。トップ（`/`）は一覧ではなく
 * 最後に更新したリストを直接出す（リストが1つしかない人に無駄な操作を作らない）。
 *
 * 判定と変換は `model.ts` の純関数。このファイルは通信と描画だけで、テストしない。
 */

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; lists: RemoteList[] }

/** 直前の操作の結果。**黙って失敗させない**ために画面へ出す。 */
type Message = { tone: 'info' | 'warn'; text: string } | null

export function ListsPage({ session }: { session: SessionState }) {
  const [, navigate] = useLocation()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [message, setMessage] = useState<Message>(null)

  /** ブラウザに残っている、まだ取り込めていない内容（#91 で上限に当たった場合） */
  const [pendingImport, setPendingImport] = useState<LocalList | null>(null)

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

  /** 取り込めずに残っている内容があるかを見る。**消さない。** */
  const checkPendingImport = useCallback(() => {
    try {
      const stored = parseStoredList(window.localStorage.getItem(LIST_STORAGE_KEY))
      setPendingImport(
        hasAnythingToImport(stored) && stored.status === 'loaded' ? stored.list : null,
      )
    } catch {
      setPendingImport(null)
    }
  }, [])

  useEffect(() => {
    if (session.status !== 'authenticated') return

    void load()
    checkPendingImport()
  }, [session.status, load, checkPendingImport])

  const createList = async () => {
    setMessage(null)

    // 上限の判定はサーバーに任せる。**画面側に同じ判定を書かない**（ずれる）
    const res = await api.api.lists.$post({ json: {} })

    if (res.status === 409) {
      setMessage({
        tone: 'warn',
        text: `リストは${String(LISTS_PER_USER_MAX)}つまでです。減らすと新しく作れます`,
      })
      return
    }

    if (!res.ok) {
      setMessage({ tone: 'warn', text: '作れませんでした。通信を確かめてください' })
      return
    }

    const body = await res.json()
    if ('list' in body) navigate(`/lists/${body.list.id}`)
  }

  const renameList = async (listId: string, title: string): Promise<boolean> => {
    setMessage(null)

    const res = await api.api.lists[':listId'].$patch({ param: { listId }, json: { title } })

    if (!res.ok) {
      setMessage({ tone: 'warn', text: 'タイトルを変えられませんでした' })
      return false
    }

    await load()
    return true
  }

  const deleteList = async (listId: string) => {
    setMessage(null)

    const res = await api.api.lists[':listId'].$delete({ param: { listId } })

    if (!res.ok) {
      setMessage({ tone: 'warn', text: '削除できませんでした' })
      return
    }

    await load()
  }

  /** 取り込めずに残っていた内容を、いま取り込む。 */
  const importPending = async () => {
    if (!pendingImport) return
    setMessage(null)

    const res = await api.api.lists.import.$post({ json: toImportBody(pendingImport) })

    if (res.status === 409) {
      setMessage({ tone: 'warn', text: 'まだ上限です。リストを減らすと取り込めます' })
      return
    }

    if (!res.ok) {
      setMessage({ tone: 'warn', text: '取り込めませんでした。通信を確かめてください' })
      return
    }

    // 🔴 **取り込めたときだけブラウザ側を消す**（#91 と同じ理由）
    try {
      window.localStorage.removeItem(LIST_STORAGE_KEY)
    } catch {
      // 消せなくても取り込みは済んでいる
    }

    setPendingImport(null)
    setMessage({ tone: 'info', text: 'このブラウザに書いていた内容を取り込みました' })
    await load()
  }

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
      <p className="mt-1 text-xs text-slate-500 tabular-nums">
        {state.lists.length} / {LISTS_PER_USER_MAX}
      </p>

      {/* Notice が <p> を描くので、ここで <p> に入れない（入れ子は不正な HTML） */}
      {message && (
        <div role="status" className="mt-3">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}

      {pendingImport && (
        <div className="mt-3 rounded bg-white px-3 py-3 text-xs text-slate-700">
          <p className="font-bold text-brand-deep">取り込めていない内容があります</p>
          <p className="mt-1">
            このブラウザに「{pendingImport.title}」（{pendingImport.items.length}件）が
            残っています。リストを減らしてから取り込んでください。
          </p>
          <button
            type="button"
            onClick={() => void importPending()}
            className="mt-2 rounded bg-brand-deep px-3 py-1.5 text-white"
          >
            取り込む
          </button>
        </div>
      )}

      <ul className="mt-4">
        {state.lists.map((list, index) => (
          <ListRow
            key={list.id}
            number={formatItemNumber(index + 1)}
            list={list}
            onRename={renameList}
            onDelete={deleteList}
          />
        ))}
      </ul>

      {/* 🔴 **上限でも押せる形にしておく。** 押せないだけだと、上限なのか
          壊れているのか区別が付かない（#77 と同じ考え方）。理由はサーバーが返す */}
      <button
        type="button"
        onClick={() => void createList()}
        className="mt-4 w-full rounded bg-brand-deep px-3 py-2 text-white"
      >
        新しいリストを作る
      </button>
    </div>
  )
}

function ListRow({
  number,
  list,
  onRename,
  onDelete,
}: {
  number: string
  list: RemoteList
  onRename: (listId: string, title: string) => Promise<boolean>
  onDelete: (listId: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(list.title)
  const [confirming, setConfirming] = useState(false)

  const commit = async () => {
    if (draft === list.title) return
    if (!(await onRename(list.id, draft))) setDraft(list.title)
  }

  return (
    <li className="border-b border-brand/40">
      <div className="flex items-center gap-2 py-2">
        <span className="w-8 shrink-0 text-right text-xs text-slate-500 tabular-nums">
          {number}
        </span>

        <input
          type="text"
          value={draft}
          aria-label={`${number} 番目のリストのタイトル`}
          // 上限は shared の定数。ここに数字を書かない（CLAUDE.md の不変条件）
          maxLength={LIST_TITLE_MAX_LENGTH}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            // 変換確定の Enter を拾わない（#79 で踏んだ）
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
          }}
          className="min-w-0 flex-1 rounded bg-transparent px-1 py-1 text-slate-900 focus:bg-white focus:outline-2 focus:outline-brand-deep"
        />

        <Link href={`/lists/${list.id}`} className="shrink-0 text-xs text-brand-deep underline">
          開く
        </Link>

        <button
          type="button"
          aria-label={`${number} 番目のリストを削除`}
          onClick={() => {
            setConfirming(true)
          }}
          className="shrink-0 px-1 text-sm text-slate-400"
        >
          ×
        </button>
      </div>

      {/* 🔴 **確認を挟む**（`PRODUCT_SPEC.md` §4.3）。項目ごと消えるため */}
      {confirming && (
        <p className="mb-2 ml-10 rounded bg-white px-2 py-2 text-xs text-slate-700">
          「{list.title}」を消すと、<strong>中の項目も一緒に消えます。</strong>
          <span className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => void onDelete(list.id)}
              className="rounded bg-brand-deep px-2 py-1 text-white"
            >
              消す
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false)
              }}
              className="rounded border border-brand px-2 py-1 text-slate-600"
            >
              やめる
            </button>
          </span>
        </p>
      )}
    </li>
  )
}
