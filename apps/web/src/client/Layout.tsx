import { SERVICE_NAME } from '@yaritai100list/shared'
import { Link } from 'wouter'

/**
 * 全画面の枠（#159）。**幅・背景・ヘッダーはここだけで決める。**
 *
 * 画面ごとに枠を書くと必ずずれる。実際、共有ページ（SSR）は別に書いてあったせいで、
 * #143 で SPA を広げたときに取り残された。
 *
 * ⚠️ **共有ページ（`src/share.ts`）は別実装。** あちらは Tailwind を通らない
 * （SSR で、ビルド後の CSS はファイル名にハッシュが付くので参照できない）。
 * **見た目を合わせるための値は `src/tokens.css` に集めてある**ので、
 * 幅や色を変えるときはそちらを直せば両方に効く。
 *
 * 共有ページには**ログインが要る導線を出さない**（見るのは URL を渡された人）。
 * 出し分けではなく実装ごと分かれているので、間違えて出す事故は起きない。
 */
export function Layout({
  showListsLink,
  children,
}: {
  /** 「すべてのリスト」への導線。ログイン中だけ出す */
  showListsLink: boolean
  children: React.ReactNode
}) {
  return (
    <div className="min-h-dvh bg-brand-soft">
      {/*
        モバイル縦1カラムを主対象にする（PRODUCT_SPEC.md §4.5）。
        広い画面では中央に寄せるだけで、**列は増やさない。**

        幅の値は `tokens.css` の `--page-max-width`（#143 / #159）。
        ⚠️ 効くのは広い画面だけ。よくある電話の横幅（約 24rem）はそれより狭い
      */}
      <div className="mx-auto max-w-(--page-max-width) px-4 pb-24">
        <header className="-mx-4 mb-4 flex items-baseline justify-between gap-3 bg-brand px-4 py-3">
          <Link href="/" className="shrink-0 text-xs font-bold text-slate-900">
            {SERVICE_NAME}
          </Link>

          <nav className="flex items-baseline gap-3 text-xs text-slate-900">
            {/*
              取り入れ面（#235）。🔴 **ログインの有無で出し分けない。**
              書き始める前の人こそ対象なので、未ログインにこそ届いてほしい。
              「すべてのリスト」と並べるのは、**どちらもリスト1つに紐付かない画面**だから
              （共有の設定と書き出しはリストの画面にだけ置く。#202）
            */}
            <Link href="/discover" className="shrink-0 underline">
              さがす
            </Link>

            {showListsLink && (
              <Link href="/lists" className="shrink-0 underline">
                すべてのリスト
              </Link>
            )}
          </nav>
        </header>

        {children}

        <SiteFooter />
      </div>
    </div>
  )
}

/**
 * フッター（#304）。**規約とポリシーへの入口。**
 *
 * 🔴 **共有ページ（`src/share.ts`）にも同じものを置く。** あちらは別実装なので、
 * ここに足しただけでは出ない（`Layout` の冒頭のコメント）。
 *
 * ⚠️ **目立たせない。** 日常的に押すものではないので、
 * 本文の邪魔をしない大きさと色にする。
 */
function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-brand/40 pt-4 text-center text-xs text-slate-500">
      <Link href="/terms" className="underline">
        利用規約
      </Link>
      <span className="px-2">·</span>
      <Link href="/privacy" className="underline">
        プライバシーポリシー
      </Link>
    </footer>
  )
}
