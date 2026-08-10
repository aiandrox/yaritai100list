import { type Visibility } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import { SignInBenefits } from './SignInBenefits'
import { shareUrl, type SessionState } from './model'

/**
 * リストの共有設定（#138）。
 *
 * 公開範囲は3段階だが、**リストの見え方は2値**（非公開か、URL を知っていれば見えるか）。
 * 全公開との差は**項目が取り入れ面に出るかどうかだけ**（`PRODUCT_SPEC.md` §5.1）。
 * 選ぶ人にはそれが分からないので、**選択肢ごとに何が起きるかを書く。**
 */

interface ListState {
  id: string
  title: string
  shareId: string
  visibility: Visibility
}

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; list: ListState }

/** 選択肢の説明。**「何ができるか」だけでなく「何が起きるか」を書く。** */
const CHOICES: { value: Visibility; label: string; description: React.ReactNode }[] = [
  {
    value: 'private',
    label: '非公開',
    description: '自分だけが見られます。リンクを渡しても開けません',
  },
  {
    value: 'unlisted',
    label: 'リンクを知っている人だけ',
    description: 'URL を渡した人が見られます。検索には出ません',
  },
  {
    value: 'public',
    label: '全体に公開',
    description: (
      <>
        URL を渡した人が見られます。さらに、書いた項目が「
        {/*
          🔴 **どこに出るのかを見に行けるようにする**（#246）。
          「みんなのやりたいこと」に並ぶと書いても、**そこがどんな場所かを
          見たことがなければ判断できない。** 公開範囲は
          「うっかり公開される経路を作らない」と決めている（`PRODUCT_SPEC.md` §5.1）ので、
          選ぶ前に確かめられる方に倒す。

          ⚠️ **リンクにするのは場所の名前だけ**（2026-08-10 の利用者の判断）。
          文を丸ごと下線にすると、**説明文なのか押すものなのかが分からなくなる**
        */}
        <Link href="/discover" className="font-bold text-brand-deep underline">
          みんなのやりたいこと
        </Link>
        」に並び、ほかの人が自分のリストに取り入れられます
      </>
    ),
  },
]

/**
 * 全公開にすると**何が出るのか**の補足。
 *
 * 🔴 **「リストごと晒される」と読まれないようにする。**
 * 出るのは項目の本文だけで、作者もリストのタイトルも出ない
 * （`PRODUCT_SPEC.md` §5.1 の「公開面は2種類あり、見せる情報が異なる」）。
 * **公開範囲を選ぶうえで一番効く情報**なので、選択肢の文言だけに任せない。
 */
function DiscoverHint() {
  return (
    <p className="mt-2 text-xs text-slate-600">
      「みんなのやりたいこと」に出るのは
      <strong className="font-bold">項目の本文だけ</strong>
      です。誰が書いたかも、リストの名前も出ません。
    </p>
  )
}

export function SharePage({ session, listId }: { session: SessionState; listId: string }) {
  // ログインが要る画面。**未ログインでは開かせない**（#112 と同じ扱い）
  if (session.status !== 'authenticated') {
    return <SignInRequired session={session} />
  }

  return <SharePageBody listId={listId} />
}

function SignInRequired({ session }: { session: SessionState }) {
  if (session.status === 'loading') return <p className="py-8 text-slate-500">読み込み中</p>

  if (session.status === 'error') {
    return (
      <Notice tone="warn">
        ログイン状態を確認できないため、この画面を開けません。通信を確かめてください
      </Notice>
    )
  }

  return (
    <Notice tone="info">
      共有の設定をするには
      <a href="/api/login/google" className="font-bold text-brand-deep underline">
        Googleでログイン
      </a>
      してください。 <SignInBenefits />
    </Notice>
  )
}

function SharePageBody({ listId }: { listId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api.api.lists[':listId'].$get({ param: { listId } })
      if (!res.ok) {
        setState({ status: 'failed' })
        return
      }

      const { list } = await res.json()
      setState({ status: 'ready', list })
    } catch {
      setState({ status: 'failed' })
    }
  }, [listId])

  useEffect(() => {
    void load()
  }, [load])

  if (state.status === 'loading') return <p className="py-8 text-slate-500">読み込み中</p>

  if (state.status === 'failed') {
    return (
      <Notice tone="warn">
        このリストを読み込めませんでした。通信を確かめて、開き直してください
      </Notice>
    )
  }

  const { list } = state
  const url = shareUrl(window.location.origin, list.shareId)

  const changeVisibility = async (visibility: Visibility) => {
    setMessage(null)
    setCopied(false)

    const res = await api.api.lists[':listId'].$patch({ param: { listId }, json: { visibility } })

    if (!res.ok) {
      setMessage('公開範囲を変えられませんでした。通信を確かめてください')
      return
    }

    await load()
  }

  const regenerate = async () => {
    setMessage(null)
    setCopied(false)
    setConfirmingRegenerate(false)

    const res = await api.api.lists[':listId']['share-id'].$post({ param: { listId } })

    if (!res.ok) {
      setMessage('作り直せませんでした。通信を確かめてください')
      return
    }

    setMessage('新しいリンクにしました。前のリンクはもう開けません')
    await load()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // 権限が無い環境がある。**黙って失敗しない。** URL は下に出してあるので選べる
      setMessage('コピーできませんでした。下の URL を選んでコピーしてください')
    }
  }

  return (
    <div>
      {/*
        🔴 **戻り先はそのリスト**（#202）。ここは「リストの下の画面」なので、
        1つ上はリストの画面。「すべてのリスト」まで飛ばすと、
        **さっきまで編集していたリストへ戻るのに選び直しが要る。**

        リスト名を出すのは、**どのリストの下にいるかを戻り先で示すため**
        （階層は2段しかないので、パンくずまでは要らない）
      */}
      <Link href={`/lists/${listId}`} className="text-xs text-brand-deep underline">
        ← {list.title}
      </Link>

      <h1 className="mt-2 text-xl font-bold text-slate-900">共有</h1>

      {message !== null && (
        <div role="status" className="mt-3">
          <Notice tone="info">{message}</Notice>
        </div>
      )}

      <section className="mt-6 rounded bg-white px-3 py-3">
        <h2 className="font-bold text-slate-900">だれが見られるか</h2>

        <ul className="mt-2">
          {CHOICES.map((choice) => (
            <li key={choice.value} className="border-t border-brand/30 py-2 first:border-t-0">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="visibility"
                  className="shrink-0"
                  checked={list.visibility === choice.value}
                  onChange={() => void changeVisibility(choice.value)}
                />
                <span className="text-sm text-slate-900">{choice.label}</span>
              </label>

              {/*
                🔴 **説明は `label` の外に置く**（#246）。
                中に入れると、**説明の中のリンクを押しただけで公開範囲が変わる**
                （`label` の中を押すと結び付いた `input` が反応するため）。
                うっかり公開される経路を作らない、という決定に直接効く
              */}
              <p className="mt-0.5 ml-6 text-xs text-slate-600">{choice.description}</p>
            </li>
          ))}
        </ul>

        <DiscoverHint />
      </section>

      {/*
        🔴 **非公開のときは URL を出さない**（#138）。
        出すと「このリンクを渡せば見える」と誤解する。実際は開けない。

        **代わりの案内も出さない**（#151）。選択肢の説明
        （「自分だけが見られます。リンクを渡しても開けません」）で足りている
      */}
      {list.visibility !== 'private' && (
        <section className="mt-4 rounded bg-white px-3 py-3">
          <h2 className="font-bold text-slate-900">共有する URL</h2>

          {/*
            URL そのものを開けるようにする（#153）。**渡す前に見え方を確かめられる。**
            別のタブで開くのは、設定の画面に戻れなくなると不便なため
          */}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block rounded bg-brand-soft px-2 py-2 text-[11px] break-all text-brand-deep underline"
          >
            {url}
          </a>
          <p className="mt-1 text-xs text-slate-500">
            押すと、渡した相手に見える画面が別のタブで開きます
          </p>

          <button
            type="button"
            onClick={() => void copy()}
            className="mt-3 w-full rounded bg-brand-deep px-3 py-2 text-white"
          >
            {copied ? 'コピーしました' : 'URL をコピー'}
          </button>

          <p className="mt-4 text-xs text-slate-600">
            渡した相手に見せたくなくなったら、リンクを作り直せます。
            <strong>作り直すと、いまの URL は開けなくなります。</strong>
          </p>

          {confirmingRegenerate ? (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void regenerate()}
                className="flex-1 rounded bg-brand-deep px-3 py-2 text-white"
              >
                作り直す
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingRegenerate(false)
                }}
                className="flex-1 rounded border border-brand px-3 py-2 text-slate-600"
              >
                やめる
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirmingRegenerate(true)
              }}
              className="mt-2 w-full rounded border border-brand px-3 py-2 text-brand-deep"
            >
              リンクを作り直す
            </button>
          )}
        </section>
      )}
    </div>
  )
}
