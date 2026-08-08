import {
  buildMarkdown,
  exportFileName,
  exportFileSchema,
  type ExportFile,
} from '@yaritai100list/shared'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'wouter'

import { api } from './api'
import { Notice } from './Notice'
import { type SessionState } from './model'

/**
 * リストを書き出す画面（#131）。
 *
 * 一覧に `JSON` と `MD` のボタンを並べていたが、**どちらが何のためのものか
 * 分からなかった。** 形式ごとに何ができるのかを、押す前に読める形にする。
 *
 * | 形式 | 用途 | 読み込める |
 * |---|---|---|
 * | JSON | このアプリに読み込み直す（別のアカウントへ移す・取っておく） | **できる** |
 * | マークダウン | ブログなどにそのまま貼る | しない |
 *
 * 🔴 **マークダウンはここで作る。** サーバーは閲覧者の時間帯を知らないので、
 * 達成日を UTC のまま日付にすると1日ずれる（#124）。
 *
 * 画像（#193）は3つ目の形式。**貼るのでも読み込むのでもなく、そのまま見せるもの。**
 * こちらだけサーバーで作る（`/api/lists/:listId/image`。#192）。
 */

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; file: ExportFile; markdown: string }

/** 画像の作成は数秒かかる。**押した後に何も起きないように見せない。** */
type ImageState = 'idle' | 'working' | 'failed'

export function ExportPage({ session, listId }: { session: SessionState; listId: string }) {
  // ログインが要る画面。**未ログインでは開かせない**（#112 と同じ扱い）
  if (session.status !== 'authenticated') {
    return <SignInRequired session={session} />
  }

  return <ExportPageBody listId={listId} />
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
      書き出すには
      <a href="/api/login/google" className="font-bold text-brand-deep underline">
        Googleでログイン
      </a>
      してください
    </Notice>
  )
}

function ExportPageBody({ listId }: { listId: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [copied, setCopied] = useState(false)
  const [image, setImage] = useState<ImageState>('idle')

  const load = useCallback(async () => {
    try {
      const res = await api.api.lists[':listId'].export.$get({ param: { listId } })
      if (!res.ok) {
        setState({ status: 'failed' })
        return
      }

      const parsed = exportFileSchema.safeParse(await res.json())
      if (!parsed.success) {
        setState({ status: 'failed' })
        return
      }

      setState({
        status: 'ready',
        file: parsed.data,
        // 日付の整形だけを渡す。中身の組み立ては shared の純関数（テストしてある）
        markdown: buildMarkdown(parsed.data, (iso) => new Date(iso).toLocaleDateString('ja-JP')),
      })
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

  const { file, markdown } = state

  const downloadJson = () => {
    const content = JSON.stringify(file, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const anchor = document.createElement('a')

    anchor.href = url
    anchor.download = exportFileName(file.list.title, new Date())
    anchor.click()

    // 解放しないとページを閉じるまでメモリに残る
    URL.revokeObjectURL(url)
  }

  /**
   * 画像を落とす。
   *
   * JSON と違って**中身はサーバーで作る**ので、
   * 押してから返るまで数秒かかる。**その間の表示を出す。**
   */
  const downloadImage = async () => {
    setImage('working')

    try {
      const res = await api.api.lists[':listId'].image.$get({ param: { listId } })
      if (!res.ok) {
        setImage('failed')
        return
      }

      const url = URL.createObjectURL(await res.blob())
      const anchor = document.createElement('a')

      anchor.href = url
      anchor.download = exportFileName(file.list.title, new Date(), 'png')
      anchor.click()

      // 解放しないとページを閉じるまでメモリに残る
      URL.revokeObjectURL(url)
      setImage('idle')
    } catch {
      setImage('failed')
    }
  }

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
    } catch {
      // 権限が無い環境がある。**黙って失敗しない。**
      // 下に中身を出してあるので、選んでコピーはできる
      setCopied(false)
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
        ← {file.list.title}
      </Link>

      <h1 className="mt-2 text-xl font-bold text-slate-900">書き出す</h1>

      <section className="mt-6 rounded bg-white px-3 py-3">
        <h2 className="font-bold text-slate-900">このアプリに読み込み直す（JSON）</h2>
        <p className="mt-1 text-xs text-slate-600">
          <strong>このアプリで読み込むための</strong>ファイルです。
          別のアカウントへ移したいときや、手元に取っておきたいときに使います。
          <br />
          読み込みは「すべてのリスト」の
          <strong>「ファイルからリストを読み込む」</strong>から。
        </p>

        <button
          type="button"
          onClick={downloadJson}
          className="mt-3 w-full rounded bg-brand-deep px-3 py-2 text-white"
        >
          JSON をダウンロード
        </button>
      </section>

      <section className="mt-4 rounded bg-white px-3 py-3">
        <h2 className="font-bold text-slate-900">画像で見せる（PNG）</h2>
        <p className="mt-1 text-xs text-slate-600">
          <strong>やりたいこと100個を1枚に並べた画像</strong>です。SNS に貼ったり、
          印刷して貼っておくのに使えます。
          <br />
          <strong>このアプリに読み込むことはできません。</strong>
        </p>

        <button
          type="button"
          onClick={() => void downloadImage()}
          disabled={image === 'working'}
          className="mt-3 w-full rounded bg-brand-deep px-3 py-2 text-white disabled:opacity-60"
        >
          {image === 'working' ? '作っています…' : '画像をダウンロード'}
        </button>

        {/* 🔴 黙って何も起きないのが一番まずい。**理由の分かる表示を出す** */}
        {image === 'failed' && (
          <p className="mt-2 text-xs text-red-700">
            画像を作れませんでした。少し待ってから、もう一度試してください
          </p>
        )}
      </section>

      <section className="mt-4 rounded bg-white px-3 py-3">
        <h2 className="font-bold text-slate-900">ブログなどに貼る（マークダウン）</h2>
        <p className="mt-1 text-xs text-slate-600">
          下の内容を<strong>そのまま貼れます</strong>。
          <br />
          <strong>このアプリに読み込むことはできません。</strong>
          戻せる形で持ち出したいときは JSON を使ってください。
        </p>

        {/* 貼る前に中身を確かめられるようにする。「そのまま貼れる」を言葉で言うより早い */}
        <pre className="mt-3 max-h-64 overflow-auto rounded bg-brand-soft px-2 py-2 text-[11px] whitespace-pre-wrap text-slate-700">
          {markdown}
        </pre>

        {/*
          ダウンロードは置かない（#133）。**貼るためのものなので、
          ファイルとして持っておく理由が薄い**（取っておきたいなら JSON がある）
        */}
        <button
          type="button"
          onClick={() => void copyMarkdown()}
          className="mt-3 w-full rounded bg-brand-deep px-3 py-2 text-white"
        >
          {copied ? 'コピーしました' : 'コピー'}
        </button>
      </section>
    </div>
  )
}
