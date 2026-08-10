import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import {
  hasText,
  rejectionMessage,
  sortAdoptedLast,
  type LocalList,
  type SessionState,
} from './model'
import { useList } from './useList'

/**
 * 取り入れ面（`PRODUCT_SPEC.md` §5.4、親 #10）。
 *
 * **他人のリストを見るページではなく、やりたいことが集まったプール。**
 * 出すのは本文だけで、**作者・完了マーク・完了日時は出さない。**
 * アイデアそのものを探す場なので、叶えたかどうかは削ぎ落とす。
 *
 * 🔴 **元のリストへのリンクを張らない。** 共有公開ページと経路として交わらせない
 * （交わると「見知らぬ人が他人のリストに着地する」状況が生まれ、作者を名乗る必要が出る）。
 *
 * 🔴 **ログインは要らない。** 書き始める前の人こそ対象なので、
 * ここでログインを要求すると機能が届かない（2026-08-08 の判断）。
 * 未ログインの取り入れ先は localStorage の1リスト。**画面は同じ。**
 *
 * ⚠️ **並びの根拠（何人が書いているか）は画面に出さない。**
 * 人数は非公開リストも数えているので、出すと
 * **何人が非公開でその本文を持っているかを問い合わせられる**（#241）。
 */

/**
 * プールの1行。
 *
 * `adopted` は**サーバーが決めた「もう持っているか」**（#254）。
 * 表記が違っても代表表現で突き合わせるので、
 * 「富士山登頂」を持っている人には「富士山に登る」が持っている扱いになる。
 * **未ログインでは常に false**（保存先が localStorage なのでサーバーは知らない）。
 */
interface PoolItem {
  text: string
  adopted: boolean
}

type PoolState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; items: PoolItem[]; hasNext: boolean }

export function DiscoverPage({ session }: { session: SessionState }) {
  const [pool, setPool] = useState<PoolState>({ status: 'loading' })

  /**
   * ページは URL に載せる（`?page=2`）。
   *
   * **戻るボタンが効き、渡したリンクが同じところを開く。**
   * 画面の中の状態にすると、1件取り入れて戻ってきたときに先頭へ飛ぶ。
   */
  const [searchParams] = useSearchParams()
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)

  /**
   * 取り入れ先は**トップと同じリスト**（最後に更新したもの。`PRODUCT_SPEC.md` §4.3）。
   *
   * 🔴 **どのリストに入れるかを選ばせない。** リストは最大5つで、
   * 選ばせると「探す」より先に「決める」が来る。ここは眺めて拾う場所。
   * 代わりに**どこに入るかを画面に書く**（黙って入れない）。
   *
   * `useList` に任せると、**未ログインなら localStorage、ログイン中ならサーバー**に
   * なる（#236）。取り入れは `addItem` を呼ぶだけで、専用の口は無い。
   */
  const controller = useList(session)
  const { screen, rejection } = controller

  /**
   * 取り入れ先のリスト。**サーバーに渡すと、そこにある本文が後ろへ回る**（#249）。
   *
   * 未ログインのときは `null`（保存先が localStorage なので、サーバーは知らない）。
   */
  const listId = screen.status === 'ready' && screen.source === 'server' ? screen.key : null

  /**
   * 並べ替えに使う手元のリスト。**`useEffect` の外から読むので ref に置く。**
   *
   * 依存に入れると、**1件取り入れるたびにプールを取り直す**ことになる。
   */
  const listRef = useRef<LocalList | null>(null)
  if (screen.status === 'ready') listRef.current = screen.list

  /**
   * 🔴 **リストが分かるまで取りに行かない。**
   *
   * 先に取ってしまうと、**リストが読めた後にもう一度取り直すことになり、
   * 並びが目の前で入れ替わる。**
   */
  const canLoad = screen.status === 'ready'

  useEffect(() => {
    if (!canLoad) return

    const load = async () => {
      setPool({ status: 'loading' })

      try {
        const res = await api.api.discover.$get({
          query: { page: String(page), ...(listId === null ? {} : { listId }) },
        })
        if (!res.ok) {
          setPool({ status: 'failed' })
          return
        }

        const body = await res.json()
        const list = listRef.current

        /**
         * 🔴 **並びを受け取った時点で決めて、あとは動かさない。**
         *
         * 毎回描くたびに並べ替えると、**1件取り入れた瞬間にその行が下へ飛び、
         * 下にあった行が全部せり上がる。** 押した本人が見失う。
         *
         * ⚠️ ログイン中はサーバーが既に並べているので、ここは効かない。
         * **未ログインのため**に残してある（サーバーは localStorage を知らない）。
         */
        setPool({
          status: 'ready',
          items: list === null ? body.items : sortAdoptedLast(body.items, list),
          hasNext: body.hasNext,
        })
      } catch {
        setPool({ status: 'failed' })
      }
    }

    void load()
  }, [page, listId, canLoad])

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-900">みんなのやりたいこと</h1>

      {rejection !== null && (
        <p role="alert" className="mt-3 rounded bg-white px-3 py-2 text-sm text-brand-deep">
          {rejectionMessage(rejection)}
        </p>
      )}

      {pool.status === 'loading' && <p className="mt-4 text-sm text-slate-600">読み込み中…</p>}

      {pool.status === 'failed' && (
        <Notice tone="warn">
          読み込めませんでした。通信を確かめて、ページを開き直してください
        </Notice>
      )}

      {pool.status === 'ready' && pool.items.length === 0 && <EmptyPool />}

      {pool.status === 'ready' && pool.items.length > 0 && (
        <>
          {/* **どこに入るかを先に書く。** 黙ってどれかのリストに入れない */}
          {screen.status === 'ready' && (
            <p className="mt-4 text-xs text-slate-600">
              取り入れると「{screen.list.title}」の最後に足されます
            </p>
          )}

          <ul className="mt-2">
            {/*
              並びは受け取った時点で決まっている（上の `load`）。
              **ここで並べ替えない。** 取り入れた瞬間に行が飛ぶ
            */}
            {pool.items.map(({ text, adopted }) => (
              <li
                key={text}
                className="flex items-center gap-2 border-b border-brand/40 py-2.5 text-sm"
              >
                <span className="min-w-0 flex-1 break-words text-slate-900">{text}</span>

                {screen.status === 'ready' &&
                  /**
                   * 🔴 **サーバーの判定を先に見る**（#254）。
                   * あちらは代表表現で突き合わせるので、**表記が違っても拾える。**
                   *
                   * `hasText` は完全一致しか見ない。残してあるのは
                   * **未ログイン**（サーバーは localStorage を知らない）と、
                   * **取り入れた直後**（プールを取り直さないので `adopted` が古い）のため。
                   */
                  (adopted || hasText(screen.list, text) ? (
                    // **消さずに残す。** 消えると「押せたのか」が分からない
                    <span className="shrink-0 text-xs text-slate-500">リストにあります</span>
                  ) : (
                    <AdoptButton text={text} onAdopt={controller.addItem} />
                  ))}
              </li>
            ))}
          </ul>

          <Pager page={page} hasNext={pool.hasNext} />
        </>
      )}
    </div>
  )
}

/**
 * ページ送り。
 *
 * ⚠️ **総ページ数を出さない。** 出すには全体を数えることになり、
 * ページを開くたびに問い合わせが2回になる。**「次があるか」だけで足りる。**
 */
function Pager({ page, hasNext }: { page: number; hasNext: boolean }) {
  if (page === 1 && !hasNext) return null

  const link = 'rounded-md border border-brand-deep px-3 py-1.5 font-bold text-brand-deep'

  return (
    <nav className="mt-4 flex items-center justify-between text-xs">
      {page > 1 ? (
        <Link
          href={page === 2 ? '/discover' : `/discover?page=${String(page - 1)}`}
          className={link}
        >
          前へ
        </Link>
      ) : (
        <span />
      )}

      <span className="text-slate-600">{page} ページ目</span>

      {hasNext ? (
        <Link href={`/discover?page=${String(page + 1)}`} className={link}>
          次へ
        </Link>
      ) : (
        <span />
      )}
    </nav>
  )
}

/**
 * 1件を自分のリストに足す。
 *
 * ⚠️ **押している間は押せなくする。** サーバーへの往復があるので、
 * 連打すると同じ本文が2件入る（重複を止める DB の制約は無い。親 #10 の判断）。
 */
function AdoptButton({
  text,
  onAdopt,
}: {
  text: string
  onAdopt: (text: string) => Promise<boolean>
}) {
  const [adding, setAdding] = useState(false)

  return (
    <button
      type="button"
      disabled={adding}
      onClick={() => {
        setAdding(true)
        void onAdopt(text).finally(() => {
          setAdding(false)
        })
      }}
      className="shrink-0 rounded-md border border-brand-deep px-3 py-1 text-xs font-bold text-brand-deep disabled:opacity-50"
    >
      取り入れる
    </button>
  )
}

/**
 * 1件も無いとき。
 *
 * 🔴 **初日に必ず通る画面。** 全公開のリストが1つも無ければ空になる。
 * **「エラーではなく、まだ貯まっていない」と分かる文面にする。**
 */
function EmptyPool() {
  return (
    <div className="mt-4 rounded-lg bg-white px-4 py-5 text-sm text-slate-600">
      <p>まだ何も集まっていません。</p>
      <p className="mt-2">
        ここに出るのは、
        <strong className="font-bold text-slate-900">全公開</strong>
        にしたリストに書かれているやりたいことです。
      </p>
      <p className="mt-2">
        <Link href="/lists" className="font-bold text-brand-deep underline">
          すべてのリスト
        </Link>
        から自分のリストを全公開にすると、ここに並びます。
      </p>
    </div>
  )
}
