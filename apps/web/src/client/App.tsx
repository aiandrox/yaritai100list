import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Route, Switch, useLocation } from 'wouter'

import { AgreementGate } from './AgreementGate'
import { api } from './api'
import { DiscoverPage } from './DiscoverPage'
import { ExportPage } from './ExportPage'
import { Layout } from './Layout'
import { ListPage } from './ListPage'
import { ListsPage } from './ListsPage'
import { PrivacyPage } from './PrivacyPage'
import { SharePage } from './SharePage'
import { TermsPage } from './TermsPage'
import { Notice } from './Notice'
import { signOutRequestInit, toSessionState, type SessionState } from './model'

/**
 * 画面の入口。**ここに残すのは全画面で共通の枠と、セッションの取得だけ。**
 *
 * ルーティングは wouter（`TECH_STACK.md` §10 の決定）。
 * 画面のパスは Worker に通していない（`wrangler.jsonc` の `run_worker_first` は
 * `/api/*` だけ）。静的ファイルに当たらないパスは
 * `not_found_handling: single-page-application` が index.html を返すので、
 * **`/lists/xxx` を直接開いてもこの SPA が起動する。**
 */
/**
 * ログイン直後の読み込みに付く印（#325）。**`/api/login/google` が付ける。**
 *
 * 🔴 **読んだらすぐ URL から消す。** 消さないとリロードでも残ってしまい、
 * 「**リロードしたら初回ではない**」という判定が効かなくなる。
 */
const WELCOME_PARAM = 'welcome'

export function App() {
  const [, navigate] = useLocation()
  const [session, setSession] = useState<SessionState>({ status: 'loading' })
  const [signOutFailed, setSignOutFailed] = useState(false)

  // --- セッション（#3 で入れた配線。消さないこと） ---

  const loadSession = useCallback(async () => {
    setSession({ status: 'loading' })

    try {
      // Better Auth のエンドポイントは Hono RPC の型に乗らないので普通の fetch で呼ぶ
      const res = await fetch('/api/auth/get-session')
      const body: unknown = await res.json()

      setSession(toSessionState({ ok: res.ok, body }))
    } catch {
      // 通信自体が失敗した場合（オフラインなど）。未ログインと区別する
      setSession({ status: 'error' })
    }
  }, [])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  // --- 規約への同意（#319） ---

  /**
   * 同意が済んでいるか。**ログイン中のときだけ聞く。**
   *
   * 🔴 **確かめられなかったときは通す**（`agreed` のまま）。
   * これは押させるための画面であって**認可ではない**ので、
   * 通信の不調でリストが開けなくなる方が害が大きい。
   */
  const [agreement, setAgreement] = useState<'unknown' | 'agreed' | 'required'>('unknown')

  /**
   * 断ったときにアカウントごと捨てるか（#325）。
   *
   * 🔴 **規約ができた後に登録した人だけ捨てる。** まだ何も書いていないため。
   * **前から居る人は捨てない**（データがある）。断ってもログアウトするだけ。
   */
  const [discardable, setDiscardable] = useState(false)

  /**
   * この読み込みがログイン直後か（#325）。
   *
   * 🔴 **すぐ URL から消す。** 残すとリロードでも「初回」に見えてしまう。
   * **消した後の状態が「リロードした後」と同じ**になるのが要点。
   */
  const justSignedIn = useRef(false)

  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has(WELCOME_PARAM)) return

    justSignedIn.current = true
    url.searchParams.delete(WELCOME_PARAM)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  /**
   * アカウントごと捨てて、未ログインの状態に戻す（#325）。
   *
   * ⚠️ **画面を開き直す。** セッションごと消えているので、
   * React の state を1つずつ戻すより確実（アカウント削除と同じ）。
   */
  const discardAccount = useCallback(async () => {
    try {
      await api.api.account.$delete()
    } finally {
      window.location.href = '/'
    }
  }, [])

  useEffect(() => {
    if (session.status !== 'authenticated') {
      setAgreement('unknown')
      return
    }

    void (async () => {
      try {
        const res = await api.api.account.$get()
        if (!res.ok) {
          setAgreement('agreed')
          return
        }

        const body = await res.json()
        if (body.agreed) {
          setAgreement('agreed')
          return
        }

        setDiscardable(body.joinedAfterTerms)

        /*
         * 🔴 **同意しないまま読み込み直したら、アカウントごと捨てる**（#325）。
         * 対象は規約ができた後に登録した人で、**まだ何も書いていない。**
         * ログイン直後の1回だけモーダルを出し、そこで決めてもらう。
         */
        if (body.joinedAfterTerms && !justSignedIn.current) {
          await discardAccount()
          return
        }

        setAgreement('required')
      } catch {
        setAgreement('agreed')
      }
    })()
  }, [session.status, discardAccount])

  const agree = useCallback(async () => {
    const res = await api.api.account.agree.$post()
    if (!res.ok) throw new Error('同意を記録できなかった')

    setAgreement('agreed')
  }, [])

  const signOut = useCallback(async () => {
    setSignOutFailed(false)

    // 要求の中身は model.ts に置いている（content-type と本文が要る理由もそこ）
    const res = await fetch('/api/auth/sign-out', signOutRequestInit())

    // **失敗を黙って飲まない。** ここで状態を取り直すと画面は「ログイン中」に
    // 戻るだけなので、利用者にはログアウトできたのか判断がつかない
    if (!res.ok) setSignOutFailed(true)

    // サーバー側でセッションを消したので、状態を取り直す
    await loadSession()

    // 🔴 **トップへ戻す**（#112）。ログインが要る画面に残ると、
    // 直前まで見えていたものが消えたように見える
    navigate('/')
  }, [loadSession, navigate])

  return (
    <Layout showListsLink={session.status === 'authenticated'}>
      <SessionArea session={session} onRetry={() => void loadSession()} />

      {/*
        規約の確認（#319 / #325）。**画面の一番手前に出す。**
        🔴 **下の画面を差し替えない。** モーダルなので、どの経路を直接開いても
        同意するまでこれが手前にある（既存の利用者はログイン状態のまま）
      */}
      {session.status === 'authenticated' && agreement === 'required' && (
        <AgreementGate
          onAgree={agree}
          onDecline={() => (discardable ? void discardAccount() : void signOut())}
          declineLabel={discardable ? '同意しない（登録をやめる）' : '同意しない（ログアウトする）'}
        />
      )}

      <Switch>
        {/* トップは一覧ではなく**最後に更新したリスト**（PRODUCT_SPEC.md §4.3）。
            リストを1つしか持っていない人に無駄な1タップを作らない */}
        <Route path="/">
          <ListPage session={session} />
        </Route>

        {/*
          取り入れ面（#235 / 親 #10）。**ログインは要らない。**
          書き始める前の人こそ対象なので、ここで認証を求めない
        */}
        <Route path="/discover">
          <DiscoverPage session={session} />
        </Route>

        <Route path="/lists">
          {/* ログアウトはここに置く。日常的に押すものではないので、
              編集画面には出さない（#114） */}
          <ListsPage
            session={session}
            signOutFailed={signOutFailed}
            onSignOut={() => void signOut()}
          />
        </Route>

        {/* :listId より先に置かなくても段数が違うので当たらないが、
            関係のある経路を近くに並べておく */}
        <Route path="/lists/:listId/export">
          {(params) => <ExportPage session={session} listId={params.listId} />}
        </Route>

        <Route path="/lists/:listId/share">
          {(params) => <SharePage session={session} listId={params.listId} />}
        </Route>

        <Route path="/lists/:listId">
          {(params) => <ListPage session={session} listId={params.listId} />}
        </Route>

        {/*
          規約とポリシー（#304）。**ログインの有無で出し分けない。**
          読むのに何も要らない
        */}
        <Route path="/terms">
          <TermsPage />
        </Route>

        <Route path="/privacy">
          <PrivacyPage />
        </Route>

        <Route>
          <Notice tone="warn">
            このページはありません。
            <Link href="/" className="underline">
              トップへ戻る
            </Link>
          </Notice>
        </Route>
      </Switch>
    </Layout>
  )
}

function SessionArea({ session, onRetry }: { session: SessionState; onRetry: () => void }) {
  return (
    <div className="mb-2 text-right text-xs text-slate-600">
      {session.status === 'error' && (
        <p>
          ログイン状態を確認できませんでした{' '}
          <button type="button" onClick={onRetry} className="underline">
            再試行
          </button>
        </p>
      )}

      {session.status === 'authenticated' && <p>ログイン中</p>}
    </div>
  )
}
