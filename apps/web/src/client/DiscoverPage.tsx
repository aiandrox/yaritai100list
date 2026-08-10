import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import { hasText, rejectionMessage, sortAdoptedLast, type SessionState } from './model'
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

type PoolState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; texts: string[]; hasNext: boolean }

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

  useEffect(() => {
    const load = async () => {
      setPool({ status: 'loading' })

      try {
        const res = await api.api.discover.$get({ query: { page: String(page) } })
        if (!res.ok) {
          setPool({ status: 'failed' })
          return
        }

        const body = await res.json()
        setPool({
          status: 'ready',
          texts: body.items.map((item) => item.text),
          hasNext: body.hasNext,
        })
      } catch {
        setPool({ status: 'failed' })
      }
    }

    void load()
  }, [page])

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

      {pool.status === 'ready' && pool.texts.length === 0 && <EmptyPool />}

      {pool.status === 'ready' && pool.texts.length > 0 && (
        <>
          {/* **どこに入るかを先に書く。** 黙ってどれかのリストに入れない */}
          {screen.status === 'ready' && (
            <p className="mt-4 text-xs text-slate-600">
              取り入れると「{screen.list.title}」の最後に足されます
            </p>
          )}

          <ul className="mt-2">
            {/*
              🔴 **既に持っているものを後ろへ回す**（#246）。
              探しに来た人にとって、もう持っているものは選択肢ではない。
              **消さない**のは「取り入れ済み」だと分かることに意味があるため
            */}
            {(screen.status === 'ready'
              ? sortAdoptedLast(pool.texts, screen.list)
              : pool.texts
            ).map((text) => (
              <li
                key={text}
                className="flex items-center gap-2 border-b border-brand/40 py-2.5 text-sm"
              >
                <span className="min-w-0 flex-1 break-words text-slate-900">{text}</span>

                {screen.status === 'ready' &&
                  (hasText(screen.list, text) ? (
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
