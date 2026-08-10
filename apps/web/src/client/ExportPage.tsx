import {
  buildMarkdown,
  DEFAULT_MARKDOWN_OPTIONS,
  exportFileName,
  exportFileSchema,
  type ExportFile,
  type MarkdownStyle,
} from '@yaritai100list/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
 *
 * 節の並びは **見せるもの（画像 → マークダウン）が先、取っておくもの（JSON）が後**（#209）。
 * JSON を使うのはアカウントを移すときだけで、**一番出番が少ないものを一番上に置かない。**
 */

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; file: ExportFile }

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

  /**
   * マークダウンの形式（#209）。
   *
   * **覚えない。** 開き直せば #124 で決めた既定に戻る。
   * 前回の選択が黙って残ると、**プレビューを見ずにコピーしたときに
   * 意図しない形が貼られる**（この画面での作業は毎回1回で終わる）。
   */
  const [style, setStyle] = useState<MarkdownStyle>(DEFAULT_MARKDOWN_OPTIONS.style)
  const [showCompletedDate, setShowCompletedDate] = useState(
    DEFAULT_MARKDOWN_OPTIONS.showCompletedDate,
  )

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

      setState({ status: 'ready', file: parsed.data })
    } catch {
      setState({ status: 'failed' })
    }
  }, [listId])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 貼るための文字列。**形式を変えたらその場で作り直す。**
   *
   * 組み立ては shared の純関数（テストしてある）。ここから渡すのは
   * **日付の整形だけ**で、これは時間帯のため（`buildMarkdown`）。
   */
  const markdown = useMemo(
    () =>
      state.status === 'ready'
        ? buildMarkdown(state.file, (iso) => new Date(iso).toLocaleDateString('ja-JP'), {
            style,
            showCompletedDate,
          })
        : '',
    [state, style, showCompletedDate],
  )

  // 中身が変われば「コピーしました」は嘘になる。**貼るのはいま見えているもの**
  useEffect(() => {
    setCopied(false)
  }, [markdown])

  if (state.status === 'loading') return <p className="py-8 text-slate-500">読み込み中</p>

  if (state.status === 'failed') {
    return (
      <Notice tone="warn">
        このリストを読み込めませんでした。通信を確かめて、開き直してください
      </Notice>
    )
  }

  const { file } = state

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
        <h2 className="font-bold text-slate-900">画像で見せる（PNG）</h2>
        <p className="mt-1 text-xs text-slate-600">
          <strong>やりたいこと100個を1枚に並べた画像</strong>です。SNS に貼ったり、
          印刷して貼っておくのに使えます。
          <br />
          <strong>このアプリに読み込むことはできません。</strong>
        </p>

        {/*
          何が出てくるかを押す前に見せる（#240）。
          **画像はサーバーで作るので数秒かかる。** 待った末に思っていたものと違ったら、
          その時間は丸損になる（JSON とマークダウンは中身をこの画面で確かめられる）。

          🔴 **本人のリストのプレビューではなく、焼いておいた見本。**
          本物を出すと**画面を開いただけで生成サービスを叩く**ことになり、
          数秒とレート制限の枠（60秒で10回。#192）を消費する。

          作り直しは `apps/render` の `deno task sample`。
          **テンプレートを変えたら流し直すこと**（ずれた見本はかえって不信を招く）。
        */}
        <img
          src="/export-sample.png"
          alt="4列25行に番号付きで100個分の枠が並び、書いた項目が入っている画像。叶えた項目には打ち消し線が引かれている"
          // 実物は 2000x1414。**縮小したものを置いてある**（`sample-export.ts`）。
          // 寸法を書いておかないと、読み込む前後で下の文とボタンが飛ぶ
          width={800}
          height={566}
          className="mt-3 w-full rounded border border-brand"
        />
        <p className="mt-1 text-xs text-slate-500">
          これは見本です。<strong>実際にはあなたのリストの内容で作られます。</strong>
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
          下の内容を<strong>そのまま貼れます</strong>。貼る先に合わせて形を選べます。
          <br />
          <strong>このアプリに読み込むことはできません。</strong>
          戻せる形で持ち出したいときは JSON を使ってください。
        </p>

        <MarkdownOptionsForm
          style={style}
          showCompletedDate={showCompletedDate}
          onStyleChange={setStyle}
          onShowCompletedDateChange={setShowCompletedDate}
        />

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

      <section className="mt-4 rounded bg-white px-3 py-3">
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
    </div>
  )
}

/**
 * 行の形の選択肢。
 *
 * **見本は添えない。** すぐ下がプレビューなので、
 * 選択肢の横にも出すと**同じものが2箇所に出る**（2026-08-08 の利用者の指示）。
 */
const STYLES: { value: MarkdownStyle; label: string }[] = [
  { value: 'checklist', label: 'チェックリスト' },
  { value: 'numbered', label: '連番' },
]

/**
 * マークダウンの形の選択（#209）。
 *
 * 下にプレビューがあるので、**ここでは結果を文章で説明しない。**
 * 押せば下が変わる、で足りる。
 */
function MarkdownOptionsForm({
  style,
  showCompletedDate,
  onStyleChange,
  onShowCompletedDateChange,
}: {
  style: MarkdownStyle
  showCompletedDate: boolean
  onStyleChange: (style: MarkdownStyle) => void
  onShowCompletedDateChange: (show: boolean) => void
}) {
  return (
    <div className="mt-3 rounded bg-brand-soft px-2 py-2">
      {/* 排他の選択なので radio。fieldset にしないと、何の選択なのかが読み上げに乗らない */}
      <fieldset>
        <legend className="text-xs font-bold text-slate-700">行の形</legend>

        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {STYLES.map((option) => (
            <label key={option.value} className="flex items-center gap-1 text-xs text-slate-700">
              <input
                type="radio"
                name="markdown-style"
                checked={style === option.value}
                onChange={() => {
                  onStyleChange(option.value)
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-2 flex items-center gap-1 text-xs text-slate-700">
        <input
          type="checkbox"
          checked={showCompletedDate}
          onChange={(e) => {
            onShowCompletedDateChange(e.target.checked)
          }}
        />
        達成日を出す
      </label>
    </div>
  )
}
