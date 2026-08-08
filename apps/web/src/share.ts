import { SERVICE_NAME } from '@yaritai100list/shared'
import { html, raw } from 'hono/html'
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
 * このページのスタイル。**1ファイルに閉じている。**
 *
 * SPA は Tailwind を通るが（`src/client/index.css`）、**ここはビルドを通らない**ので
 * 使えない。外部の CSS を参照しようにも、ビルド後のファイル名にはハッシュが付く。
 *
 * ⚠️ **色の値がここと `index.css` の2箇所にある。** 変えるときは両方。
 * 増やさないこと（3箇所目を作るくらいなら、生成する仕組みを入れる）。
 */
const PAGE_STYLE = `
  :root { --brand: #ffa2ab; --brand-soft: #fff5f6; --brand-deep: #b34452; --ink: #0f172a; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1rem; background: var(--brand-soft); color: var(--ink);
    font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif;
    line-height: 1.6;
  }
  main { max-width: 28rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0; }
  .count { color: var(--brand-deep); font-weight: 700; margin: .25rem 0 1rem; }
  ol { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; align-items: baseline; gap: .5rem;
    padding: .4rem 0; border-bottom: 1px solid color-mix(in srgb, var(--brand) 40%, transparent);
  }
  .number { color: #64748b; font-size: .7rem; font-variant-numeric: tabular-nums; width: 2rem; text-align: right; }
  .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  li.done .text { text-decoration: line-through; color: #94a3b8; }
  li.done .number { color: var(--brand-deep); }
  .date { color: var(--brand-deep); font-size: .65rem; font-variant-numeric: tabular-nums; }
  footer { margin-top: 2rem; text-align: center; font-size: .7rem; }
  footer a { color: var(--brand-deep); }
`

export interface SharedItem {
  text: string
  /** 完了日時（epoch ms）。未完了なら `null` */
  completedAt: number | null
}

export interface SharedList {
  title: string
  items: SharedItem[]
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
  body: HtmlEscapedString | Promise<HtmlEscapedString>
}) {
  return html`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${options.title}</title>
        <meta name="description" content="${options.description}" />

        <!-- OGP。画像（og:image）は #8 で足す -->
        <meta property="og:type" content="website" />
        <meta property="og:title" content="${options.title}" />
        <meta property="og:description" content="${options.description}" />
        <meta name="twitter:card" content="summary" />

        <!--
          🔴 検索には載せない（PRODUCT_SPEC.md §5.1）。
          「URL を知っている人だけ」が前提なので、たどり着ける経路を増やさない。
          SNS のカードは og: のメタタグを読むので、noindex でも壊れない
        -->
        <meta name="robots" content="noindex, nofollow" />

        <style>
          ${raw(PAGE_STYLE)}
        </style>
      </head>
      <body>
        <main>${options.body}</main>
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
  const completed = list.items.filter((item) => item.completedAt !== null).length
  const description = `${String(completed)} / ${String(list.items.length)} 達成`

  return layout({
    title: `${list.title}｜${SERVICE_NAME}`,
    description,
    body: html`
      <h1>${list.title}</h1>
      <p class="count">${description}</p>

      <ol>
        ${list.items.map(
          (item, index) => html`
            <li class="${item.completedAt === null ? '' : 'done'}">
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

      <footer><a href="/">${SERVICE_NAME}</a></footer>
    `,
  })
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
      <footer><a href="/">${SERVICE_NAME}</a></footer>
    `,
  })
}
