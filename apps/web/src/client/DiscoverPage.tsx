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

/** 入口に出すジャンル（#255）。**1件も無いものはサーバーが外している。** */
interface GenreEntry {
  slug: string
  label: string
}

type PoolState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; items: PoolItem[]; hasNext: boolean }

export function DiscoverPage({ session }: { session: SessionState }) {
  const [pool, setPool] = useState<PoolState>({ status: 'loading' })

  /**
   * ジャンルの入口（#255）。**一覧と別の状態にする**（#271）。
   *
   * 🔴 **読み込み中に消さないため。** 一覧と同じ状態に入れていたときは、
   * ジャンルを選ぶと `loading` に戻って `<nav>` が DOM から消えていた。
   * **横スクロールの位置は要素が持っている**ので、消えた時点で失われる。
   * 右へ流して奥のジャンルを押すと、**押した先が画面の外へ出ていた。**
   *
   * ⚠️ **読み込みに失敗しても消さない。** 入口だけ残っていれば選び直せる。
   */
  const [genres, setGenres] = useState<GenreEntry[]>([])

  /**
   * ページとジャンルは URL に載せる（`?page=2&genre=travel`）。
   *
   * **戻るボタンが効き、渡したリンクが同じところを開く。**
   * 画面の中の状態にすると、1件取り入れて戻ってきたときに先頭へ飛ぶ。
   *
   * 🔴 **ジャンルはスラッグ**（#255）。日本語のラベルを URL に入れない。
   */
  const [searchParams] = useSearchParams()
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1)
  const genre = searchParams.get('genre')

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
          query: {
            page: String(page),
            ...(listId === null ? {} : { listId }),
            ...(genre === null ? {} : { genre }),
          },
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
        setGenres(body.genres)
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
  }, [page, listId, genre, canLoad])

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-900">みんなのやりたいこと</h1>

      {rejection !== null && (
        <p role="alert" className="mt-3 rounded bg-white px-3 py-2 text-sm text-brand-deep">
          {rejectionMessage(rejection)}
        </p>
      )}

      {/*
        🔴 **一覧より先に、条件を付けずに置く**（#271）。
        `pool.status` で出し分けると、ジャンルを選ぶたびに消えて描き直され、
        **横スクロールの位置が左端に戻る。** 1件目を読むまでは中身が空なので、
        `GenreNav` 自身が何も描かない
      */}
      <GenreNav genres={genres} current={genre} />

      {pool.status === 'loading' && <p className="mt-4 text-sm text-slate-600">読み込み中…</p>}

      {pool.status === 'failed' && (
        <Notice tone="warn">
          読み込めませんでした。通信を確かめて、ページを開き直してください
        </Notice>
      )}

      {pool.status === 'ready' && pool.items.length === 0 && <EmptyPool genre={genre} />}

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

          <Pager page={page} hasNext={pool.hasNext} genre={genre} />
        </>
      )}
    </div>
  )
}

/**
 * 取り入れ面の URL を作る。**ページとジャンルを取り違えないよう1箇所に集める。**
 *
 * 既定（1ページ目・ジャンル指定なし）は `?` を付けない。
 * **同じ画面に2つの URL があると、戻るボタンの履歴が汚れる。**
 */
function discoverHref({ page = 1, genre }: { page?: number; genre?: string | null }): string {
  const params = new URLSearchParams()
  if (genre != null) params.set('genre', genre)
  if (page > 1) params.set('page', String(page))

  const query = params.toString()

  return query === '' ? '/discover' : `/discover?${query}`
}

/**
 * ジャンルの入口（#255）。
 *
 * - **横スクロールの1行。** 1行で済み、一覧が下に押されない
 * - **既定は「すべて」。** いきなり選ばせない
 * - **1件も無いジャンルは出さない**（サーバーが外している）。押しても空、が起きない
 * - 🔴 この2つは噛み合っている。**貯まっていないうちは数個しか並ばないので、
 *   そもそも横スクロールが要らない**
 *
 * ⚠️ **ジャンルを変えたら1ページ目に戻す**（`discoverHref` に `page` を渡さない）。
 * 3ページ目から件数の少ないジャンルへ移ると、**空の画面に着地する。**
 *
 * 🔴 **描き続けること。読み込み中に消さない**（#271）。
 * 横スクロールの位置は `<nav>` が持っているので、**一度消すと左端に戻る。**
 * 空のときにここが `null` を返すのは、**まだ1件も読めていないときだけ**にする。
 */
function GenreNav({ genres, current }: { genres: GenreEntry[]; current: string | null }) {
  // 1つも無ければ入口ごと出さない（「すべて」だけの行に意味が無い）
  if (genres.length === 0) return null

  const chip = 'shrink-0 rounded-full border px-3 py-1 text-xs whitespace-nowrap'
  const on = `${chip} border-brand-deep bg-brand-deep font-bold text-white`
  const off = `${chip} border-brand bg-white text-slate-700`

  return (
    /*
     * ⚠️ **見切れを作る**（`-mr-4 pr-4`）。右端でぴったり切ると
     * 「まだ続く」ことが分からない。`overflow-x-auto` だけでは足りない
     */
    <nav className="-mr-4 mt-3 flex gap-2 overflow-x-auto pb-1 pr-4">
      <Link href={discoverHref({})} className={current === null ? on : off}>
        すべて
      </Link>

      {genres.map(({ slug, label }) => (
        <Link
          key={slug}
          href={discoverHref({ genre: slug })}
          className={current === slug ? on : off}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}

/**
 * ページ送り。
 *
 * ⚠️ **総ページ数を出さない。** 出すには全体を数えることになり、
 * ページを開くたびに問い合わせが2回になる。**「次があるか」だけで足りる。**
 *
 * ⚠️ **ジャンルを引き継ぐ**（#255）。落とすと、2ページ目で絞り込みが外れる。
 */
function Pager({ page, hasNext, genre }: { page: number; hasNext: boolean; genre: string | null }) {
  if (page === 1 && !hasNext) return null

  const link = 'rounded-md border border-brand-deep px-3 py-1.5 font-bold text-brand-deep'

  return (
    <nav className="mt-4 flex items-center justify-between text-xs">
      {page > 1 ? (
        <Link href={discoverHref({ page: page - 1, genre })} className={link}>
          前へ
        </Link>
      ) : (
        <span />
      )}

      <span className="text-slate-600">{page} ページ目</span>

      {hasNext ? (
        <Link href={discoverHref({ page: page + 1, genre })} className={link}>
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
 *
 * ⚠️ **ジャンルを指定しているときは別の文面**（#255）。
 * 入口には空のジャンルを出していないので普通は通らないが、
 * **貼られた URL を後から開くと通る**（その間にプールが変わっている）。
 * 全公開の説明を出しても的外れなので、「すべて」へ戻す。
 */
function EmptyPool({ genre }: { genre: string | null }) {
  if (genre !== null) {
    return (
      <div className="mt-4 rounded-lg bg-white px-4 py-5 text-sm text-slate-600">
        <p>このジャンルには、いま何もありません。</p>
        <p className="mt-2">
          <Link href={discoverHref({})} className="font-bold text-brand-deep underline">
            すべて
          </Link>
          から探せます。
        </p>
      </div>
    )
  }

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
