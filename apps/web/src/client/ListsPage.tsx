import { LISTS_PER_USER_MAX, NEW_LIST_TITLE } from '@yaritai100list/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import {
  hasAnythingToImport,
  LIST_STORAGE_KEY,
  parseStoredList,
  sortListsByCreated,
  toImportBody,
  type LocalList,
  type RemoteList,
  type SessionState,
} from './model'

/**
 * リストの一覧（`PRODUCT_SPEC.md` §4.3 の「マイリスト管理」）。
 * **画面での呼び名は「すべてのリスト」**（#110）。
 *
 * ここは**切り替えと管理のための画面**。トップ（`/`）は一覧ではなく
 * 最後に更新したリストを直接出す（リストが1つしかない人に無駄な操作を作らない）。
 *
 * 判定と変換は `model.ts` の純関数。このファイルは通信と描画だけで、テストしない。
 */

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; lists: RemoteList[] }

/** 直前の操作の結果。**黙って失敗させない**ために画面へ出す。 */
type Message = { tone: 'info' | 'warn'; text: string } | null

/**
 * 読み込みが断られた理由の文言（#122 の応答に対応）。
 *
 * **サーバーが返す理由をそのまま出さない。** 利用者が次に何をすればいいか分かる形にする。
 */
const RESTORE_MESSAGES: Record<string, string> = {
  'Unsupported Export Version':
    'このファイルは、いまのアプリでは読み込めない形式です（版が違います）',
  'Future Completion Date': '未来の日付が入っているため読み込めません',
  'List Limit Reached': `リストは${String(LISTS_PER_USER_MAX)}つまでです。減らすと読み込めます`,
}

export function ListsPage({
  session,
  signOutFailed,
  onSignOut,
}: {
  session: SessionState
  signOutFailed: boolean
  onSignOut: () => void
}) {
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
      setState({ status: 'ready', lists: sortListsByCreated(lists) })
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

    // 画面でも押せないようにしているが（#107）、**サーバーの 409 も受ける。**
    // 別のタブで作った直後など、画面の件数が古いことがある。
    //
    // 名前は shared の定数。**最初の1つ（DEFAULT_LIST_TITLE）とは別の名前**にして、
    // 増やしたときに一覧で見分けられるようにする（#110）
    const res = await api.api.lists.$post({ json: { title: NEW_LIST_TITLE } })

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

  /** 書き出したファイルを読み込む（#122）。**新しいリストとして増える。** */
  const restoreList = async (file: File) => {
    setMessage(null)

    let body: unknown
    try {
      body = JSON.parse(await file.text())
    } catch {
      setMessage({ tone: 'warn', text: 'このファイルは読み込めません（JSON ではありません）' })
      return
    }

    const res = await fetch('/api/lists/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const failure: { error?: string } = await res.json<{ error?: string }>().catch(() => ({}))

      setMessage({
        tone: 'warn',
        text: RESTORE_MESSAGES[failure.error ?? ''] ?? 'このファイルは読み込めません',
      })
      return
    }

    setMessage({ tone: 'info', text: 'ファイルからリストを読み込みました' })
    await load()
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

  const atLimit = state.lists.length >= LISTS_PER_USER_MAX

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-900">すべてのリスト</h1>
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
            このブラウザに「{pendingImport.title}」が残っています。
            リストを減らしてから取り込んでください。
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
        {state.lists.map((list) => (
          <ListRow key={list.id} list={list} onDelete={deleteList} />
        ))}
      </ul>

      {/*
        上限に達していたら**押せないようにして、押す前から理由を出す**（#107）。

        完了ボタン（#77）を disabled にしないのとは扱いが違う。あちらは
        「なぜ押せないか」がログイン状態に依るので押させて説明する必要があるが、
        こちらは**件数を見れば押す前に理由を出せる。** 押させる意味が無い。

        上限の値は `packages/shared` の定数。**画面側に別の数字を書かない。**
      */}
      {atLimit ? (
        <Notice tone="info">
          リストは{LISTS_PER_USER_MAX}つまでです。新しく作るには、どれかを削除してください
        </Notice>
      ) : null}

      <button
        type="button"
        disabled={atLimit}
        onClick={() => void createList()}
        className="mt-4 w-full rounded bg-brand-deep px-3 py-2 text-white disabled:bg-slate-300 disabled:text-slate-500"
      >
        新しいリストを作る
      </button>

      <RestoreField onPick={restoreList} />

      {/*
        ログアウトの置き場所（#114）。**編集画面には出さない。**
        日常的に押すものではないうえ、誤って押すとリストが消えたように見える。
        それでも消さないのは、アカウントを間違えたときに直せなくなるため
        （`TECH_STACK.md` §9 の「サーバー側から失効できる」出口でもある）。
      */}
      <div className="mt-12 border-t border-brand/40 pt-4 text-center">
        <button type="button" onClick={onSignOut} className="text-xs text-slate-500 underline">
          ログアウト
        </button>

        {signOutFailed && <p className="mt-1 text-xs text-brand-deep">ログアウトに失敗しました</p>}
      </div>
    </div>
  )
}

function ListRow({
  list,
  onDelete,
}: {
  list: RemoteList
  onDelete: (listId: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)

  return (
    <li className="border-b border-brand/40">
      <div className="flex items-center gap-2">
        {/* 🔴 **一覧では名前を編集できない**（#110）。名前を押すとそのリストへ行く。
            名前を直すのはリストの画面。編集の場所を2つ作ると、
            どちらが効いているのか分からなくなる

            🔴 **番号を出さない**（#202）。項目には 001〜100 という枠があるが、
            **リストに番号は無い。** 並び順に意味を持たせて見せる理由がない */}
        <Link href={`/lists/${list.id}`} className="min-w-0 flex-1 truncate py-3 text-slate-900">
          {list.title}
        </Link>

        {/*
          🔴 **共有と書き出しへの入口はここに置かない**（#202）。
          置くと一覧が操作の集約場所になる。**ここは「どれを開くか」を選ぶ場所。**
          入口はリストの画面に1つだけ置く（`ListPage.tsx`）
        */}
        <button
          type="button"
          aria-label={`「${list.title}」を削除`}
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
        <p className="mb-2 rounded bg-white px-2 py-2 text-xs text-slate-700">
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

/**
 * ファイルを選んで読み込む。
 *
 * `<input type="file">` は見た目を整えにくいので隠し、ボタンから開く。
 * **同じファイルを続けて選べるように、読み込んだら値を空に戻す**
 * （戻さないと `change` が起きず、2回目が無反応になる）。
 */
function RestoreField({ onPick }: { onPick: (file: File) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <div className="mt-6 text-center">
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''

          if (file) void onPick(file)
        }}
      />

      <button
        type="button"
        onClick={() => input.current?.click()}
        className="text-xs text-brand-deep underline"
      >
        ファイルからリストを読み込む
      </button>
    </div>
  )
}
