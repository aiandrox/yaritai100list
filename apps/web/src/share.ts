import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, SERVICE_NAME } from '@yaritai100list/shared'
import { html, raw } from 'hono/html'

// 🔴 **色と幅は SPA と同じファイルから読む**（#159）。
// 別々に書くと必ずずれる（実際 #143 で SPA だけ広がった）
import tokens from './tokens.css?raw'
// 型は `hono/html` から出ていないので、実体のある場所から取る
import type { HtmlEscapedString } from 'hono/utils/html'

/**
 * 共有公開ページの中身（#137）。
 *
 * **描画だけをここに置く。** 認可（非公開を弾く）は呼び出し側で済ませ、
 * ここには**見せてよいデータだけ**が渡ってくる（`CLAUDE.md` の不変条件と同じ考え方）。
 *
 * 🔴 **作者を出さない**（`PRODUCT_SPEC.md` §5.1）。
 * 渡す型に作者の情報が無いので、**書こうと思っても書けない。**
 *
 * JSX ではなく `hono/html` を使っている。理由は2つ:
 *
 * - **`${}` が自動でエスケープされる。** 利用者が書いた文字がそのまま入るので、
 *   ここを取り違えると XSS になる。既定で安全な方を選ぶ
 * - JSX にすると Worker 側の tsconfig に `jsxImportSource: hono/jsx` が要る。
 *   **クライアントは React の JSX** なので、1つの Vite プロジェクトで2種類の JSX を
 *   扱うことになり、ビルド設定が壊れやすい
 */

/**
 * このページのスタイル。
 *
 * SPA は Tailwind を通るが（`src/client/index.css`）、**ここはビルドを通らない。**
 * 外部の CSS を参照しようにも、ビルド後のファイル名にはハッシュが付く。
 * そこで**素の CSS を書く**が、🔴 **色と幅は `tokens.css` から読む**（#159）。
 * 値を2箇所に書くと必ずずれる。
 *
 * 見た目は SPA の枠（`src/client/Layout.tsx`）に合わせてある。
 * **合わせないものは意図的に**: ログイン状態も「すべてのリスト」への導線も出さない
 * （見るのは URL を渡された人で、この人はログインしていない）。
 */
const PAGE_STYLE = `
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--brand-soft); color: #0f172a;
    font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif;
    line-height: 1.6;
  }
  .page { max-width: var(--page-max-width); margin: 0 auto; padding: 0 1rem 6rem; }
  header {
    background: var(--brand); margin: 0 -1rem 1rem; padding: .75rem 1rem;
    font-size: .75rem; font-weight: 700;
  }
  header a { color: #0f172a; text-decoration: none; }
  h1 { font-size: 1.25rem; margin: 0; }
  .count { color: var(--brand-deep); font-weight: 700; margin: .25rem 0 1rem; }
  ol { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; align-items: center; gap: .5rem; min-height: 2.75rem;
    padding: .375rem 0; border-bottom: 1px solid color-mix(in srgb, var(--brand) 40%, transparent);
  }
  .number { color: #64748b; font-size: .75rem; font-variant-numeric: tabular-nums; width: 2rem; text-align: right; }
  .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  li.done .text { text-decoration: line-through; color: #94a3b8; }
  li.done .number { color: var(--brand-deep); }
  .date { color: var(--brand-deep); font-size: .65rem; font-variant-numeric: tabular-nums; }

  /* 下の導線（#225）。**人のリストの続きに見えないよう、はっきり離す** */
  .invite { margin-top: 2.5rem; padding: 1.25rem 1rem; background: #fff; border-radius: .25rem; text-align: center; }
  .invite h2 { font-size: 1rem; margin: 0; }
  .invite p { font-size: .75rem; color: #475569; margin: .5rem 0 0; }
  .invite a {
    display: inline-block; margin-top: 1rem; padding: .625rem 1.5rem;
    background: var(--brand-deep); color: #fff; border-radius: .25rem;
    font-weight: 700; text-decoration: none;
  }
`

export interface SharedItem {
  /**
   * **すでに見せてよい形になった本文。** 伏せる項目（#237）は、
   * ここに実本文ではなく `SHARE_HIDDEN_ITEM_LABEL` が入った状態で渡ってくる
   * （呼び出し側の `src/index.ts` が詰め替える。ここでは判定しない）。
   */
  text: string
  /**
   * 達成しているか。打ち消し線・番号の色・達成数のカウントに使う（#237）。
   * 🔴 **`completedAt` とは独立させてある。** 伏せた項目は達成していても
   * `completedAt` が `null` になるため、見た目とカウントは `completedAt` では判定できない。
   */
  completed: boolean
  /** 表示する完了日時（epoch ms）。未完了、または伏せた項目なら `null` */
  completedAt: number | null
}

export interface SharedList {
  title: string
  items: SharedItem[]
  /** OGP 画像の絶対 URL（#173）。呼び出し側で組み立てる（`src/og.ts`） */
  imageUrl: string
}

/**
 * 完了日を**日本時間**で描く。
 *
 * サーバーで描くので**閲覧者の時間帯が分からない。**
 * マークダウン（#124）はクライアントで整形して避けたが、
 * このページは JavaScript 無しで読めることを優先しているので、ここで決め打つ。
 * 日本語のサービスなので日本時間にする。
 */
function formatCompletedAt(completedAt: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
  }).format(new Date(completedAt))
}

/**
 * ページの外枠。**共有ページと「見つからない」で同じものを使う。**
 *
 * 見た目を揃えるためだけでなく、**片方にだけ何かを足してしまう事故**を防ぐため。
 */
function layout(options: {
  title: string
  description: string
  /** OGP 画像の絶対 URL（#173）。「見つからない」ページには無い */
  imageUrl?: string
  body: HtmlEscapedString | Promise<HtmlEscapedString>
}) {
  return html`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${options.title}</title>
        <meta name="description" content="${options.description}" />

        <!--
          OGP（#173）。画像があるときだけ大きいカードにする。
          🔴 **画像が無いのに summary_large_image にしない。**
          画像の枠だけが空いたカードになる。
          ⚠️ この中にバッククォートを書かない（テンプレートリテラルが終わる）
        -->
        <meta property="og:type" content="website" />
        <meta property="og:title" content="${options.title}" />
        <meta property="og:description" content="${options.description}" />
        ${
          options.imageUrl === undefined
            ? html`<meta name="twitter:card" content="summary" />`
            : html`
                <meta property="og:image" content="${options.imageUrl}" />
                <meta property="og:image:width" content="${String(OG_IMAGE_WIDTH)}" />
                <meta property="og:image:height" content="${String(OG_IMAGE_HEIGHT)}" />
                <meta name="twitter:card" content="summary_large_image" />
              `
        }

        <!--
          🔴 検索には載せない（PRODUCT_SPEC.md §5.1）。
          「URL を知っている人だけ」が前提なので、たどり着ける経路を増やさない。
          SNS のカードは og: のメタタグを読むので、noindex でも壊れない
        -->
        <meta name="robots" content="noindex, nofollow" />

        <style>
          ${raw(tokens)}
          ${raw(PAGE_STYLE)}
        </style>
      </head>
      <body>
        <div class="page">
          <header><a href="/">${SERVICE_NAME}</a></header>
          <main>${options.body}</main>
        </div>
      </body>
    </html>`
}

/**
 * 共有ページ。**読み取り専用。編集の入口を出さない**（`PRODUCT_SPEC.md` §5.1）。
 *
 * 未入力の枠は出さない。**書いたものだけを見せる**
 * （100行の空欄を人に見せる意味がない。マークダウン #124 と同じ判断）。
 */
export function renderSharePage(list: SharedList): HtmlEscapedString | Promise<HtmlEscapedString> {
  // 🔴 **達成数は `completed` から数える**（#237）。伏せた項目も `completedAt` は `null` に
  // なるが、達成しているかどうかは見せてよいので、そちらまで数から落とさない
  const completed = list.items.filter((item) => item.completed).length
  const description = `${String(completed)} / ${String(list.items.length)} 達成`

  return layout({
    title: `${list.title}｜${SERVICE_NAME}`,
    description,
    imageUrl: list.imageUrl,
    body: html`
      <h1>${list.title}</h1>
      <p class="count">${description}</p>

      <ol>
        ${list.items.map(
          (item, index) => html`
            <li class="${item.completed ? 'done' : ''}">
              <span class="number">${String(index + 1).padStart(3, '0')}</span>
              <span class="text">${item.text}</span>
              ${
                item.completedAt === null
                  ? raw('')
                  : html`<span class="date">${formatCompletedAt(item.completedAt)}</span>`
              }
            </li>
          `,
        )}
      </ol>

      ${invite()}
    `,
  })
}

/**
 * 下に置く導線（#225）。**共有ページはこのサービスの入口。**
 *
 * URL を渡されて開く人は、たいてい**ここで初めてこのサービスを見る。**
 * それなのに読み終わったら行き止まりで、自分も書けることがどこにも書いていなかった。
 *
 * 🔴 **リンク先は `/`。ログインの導線にしない。**
 * 未ログインでもその場で書けること（`PRODUCT_SPEC.md` §1）が一番の売りで、
 * **入口でログインを要求したら台無しになる。**
 * 共有ページにログインの導線を出さないという方針（`src/client/Layout.tsx`）とも揃う。
 *
 * 🔴 **`<button>` を使わない。** 「読み取り専用。編集の入口を出さない」の
 * テストが `<form>` / `<input>` / `<button>` を見張っている（`test/share-page.test.ts`）。
 * 実際これはリンクなので、`<a>` が正しい。
 */
function invite(): HtmlEscapedString {
  return html`
    <aside class="invite">
      <h2>やりたいこと、書いてみませんか</h2>
      <p>登録は要りません。開いたその場で書き始められます。</p>
      <a href="/">自分のリストを作る</a>
    </aside>
  ` as HtmlEscapedString
}

/**
 * 見つからないとき。
 *
 * 🔴 **非公開のリストと、存在しない ID で同じものを返す。**
 * 出し分けると「その ID は存在するが非公開」と分かってしまい、
 * 推測不可能な ID にしている意味が薄れる（`requireOwnedList` と同じ考え方）。
 */
export function renderShareNotFound(): HtmlEscapedString | Promise<HtmlEscapedString> {
  return layout({
    title: `見つかりません｜${SERVICE_NAME}`,
    description: 'このページは見つかりませんでした',
    body: html`
      <h1>見つかりません</h1>
      <p>このリンクは無効になっているか、公開されていません。</p>
    `,
  })
}
