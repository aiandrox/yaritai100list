import { SHARE_HIDDEN_ITEM_LABEL, type Visibility } from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import { SignInBenefits } from './SignInBenefits'
import { canUseShareSheet, isShareCancelled, shareUrl, type SessionState } from './model'

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

/**
 * 共有で見せない設定（#237）のプレビューに使う分だけの項目の形。
 *
 * `RemoteItem`（`model.ts`）を広げていない。あちらは編集画面（`ListEditor.tsx`）が
 * 使う形で、この画面専用の `hiddenInShare` を足すと無関係な画面まで影響範囲に入ってしまう。
 */
interface ShareItemState {
  id: string
  text: string
  hiddenInShare: boolean
}

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; list: ListState; items: ShareItemState[] }

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

      const { list, items } = await res.json()
      setState({ status: 'ready', list, items })
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

  const { list, items } = state
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

  /**
   * 項目ごとの「共有する」（#237）。
   *
   * 🔴 **チェックを楽観的に即反映する**（2026-08-10 の利用者のフィードバック）。
   * サーバーの応答を待ってから `load()` で描き直すと、押した瞬間に見た目が変わらず
   * 「効いたのか」が分かりにくい。先に見た目を変え、失敗したときだけ `load()` で戻す。
   */
  const toggleHidden = async (itemId: string, hiddenInShare: boolean) => {
    setMessage(null)
    setCopied(false)

    setState((current) =>
      current.status === 'ready'
        ? {
            ...current,
            items: current.items.map((item) =>
              item.id === itemId ? { ...item, hiddenInShare } : item,
            ),
          }
        : current,
    )

    const res = await api.api.lists[':listId'].items[':itemId'].$patch({
      param: { listId, itemId },
      json: { hiddenInShare },
    })

    if (!res.ok) {
      setMessage('変えられませんでした。通信を確かめてください')
      await load() // 見た目を実際の状態に戻す
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

  /**
   * 端末の共有シートに渡す（#275）。
   *
   * **主対象はモバイルの縦1カラム**（`PRODUCT_SPEC.md` §4.5）。
   * コピーだけだと LINE に送るのに「コピー → アプリを切り替え → 貼り付け」の3手が要る。
   *
   * ⚠️ **渡すのは URL とタイトルだけ。** 画像は渡さない（別の作業）。
   */
  const share = async () => {
    setMessage(null)

    try {
      await navigator.share({ title: list.title, url })
    } catch (error) {
      // 🔴 **閉じただけなら何も出さない**（`isShareCancelled`）
      if (isShareCancelled(error)) return

      setMessage('共有できませんでした。URL をコピーして渡してください')
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

        🔴 **項目ごとの表示設定（下）より先に出す**（2026-08-10 の利用者のフィードバック）。
        「誰に渡す URL か」が先に分かってから「その相手に何を見せるか」を選ぶ順にする
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

          {/*
            🔴 **共有シートが使えるときだけ出す**（#275）。
            出せない環境（デスクトップの Firefox など）で並べると、
            **押せるのに何も起きないボタン**になる。

            使えるときはこちらを主にする。**渡す相手を選ぶところまで1タップ**で行けるので、
            コピーして貼り付けるより短い
          */}
          {canUseShareSheet(navigator) && (
            <button
              type="button"
              onClick={() => void share()}
              className="mt-3 w-full rounded bg-brand-deep px-3 py-2 text-white"
            >
              共有する
            </button>
          )}

          <button
            type="button"
            onClick={() => void copy()}
            className={
              canUseShareSheet(navigator)
                ? 'mt-2 w-full rounded border border-brand-deep px-3 py-2 font-bold text-brand-deep'
                : 'mt-3 w-full rounded bg-brand-deep px-3 py-2 text-white'
            }
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

      {/*
        項目ごとの表示設定（#237）。**公開範囲が非公開のときは出さない**
        （公開していなければ、隠しても意味が無い。上の URL セクションと同じ条件）。

        🔴 **チェックは「共有する」を意味する**（2026-08-10 の利用者のフィードバック）。
        「見せない」をチェックする形は、チェックが付いている＝何か強調された状態というのが
        直感と逆になる（何かを増やす操作に見える）。「共有する」をチェックにすれば、
        外す＝隠す、という自然な向きになる

        🔴 **本文は常に実際のテキストを出す。伏せない。** ここは持ち主専用の画面で、
        「どれを隠しているか」を見分けて操作できる必要がある
      */}
      {list.visibility !== 'private' && items.length > 0 && (
        <section className="mt-4 rounded bg-white px-3 py-3">
          <h2 className="font-bold text-slate-900">共有する項目</h2>
          <p className="mt-1 text-xs text-slate-600">
            チェックを外すと、共有ページでその項目の本文が
            <strong className="font-bold">{SHARE_HIDDEN_ITEM_LABEL}</strong>
            になります。番号と達成状況はそのまま出ます
          </p>

          <ul className="mt-2">
            {items.map((item, index) => (
              <li key={item.id} className="border-t border-brand/30 py-2 first:border-t-0">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={!item.hiddenInShare}
                    onChange={() => void toggleHidden(item.id, !item.hiddenInShare)}
                  />
                  <span className="w-8 shrink-0 text-right text-xs tabular-nums text-slate-500">
                    {String(index + 1).padStart(3, '0')}
                  </span>
                  {/*
                    🔴 **打ち消し線は「隠れているか」を表す**（2026-08-10）。
                    チェックを外した瞬間、`toggleHidden` の楽観更新で `item.hiddenInShare` が
                    即座に変わるので、サーバーの応答を待たずにここへ反映される
                  */}
                  <span
                    className={`min-w-0 flex-1 break-words text-sm ${
                      item.hiddenInShare ? 'text-slate-400 line-through' : 'text-slate-900'
                    }`}
                  >
                    {item.text}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
