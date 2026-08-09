/**
 * サービスの名前まわり。
 *
 * `index.ts` から分けてあるのは、**他のモジュールから読めるようにする**ため
 * （`index.ts` を読むと、そこが再輸出しているものと循環する）。
 */

/**
 * サービス名。ページタイトルと画像出力の右上で使う。
 *
 * 既定のリスト名（`DEFAULT_LIST_TITLE`）とは別物。画面上で紛れないようにする。
 */
export const SERVICE_NAME = 'やりたいことリスト100'

/** 英語名。リポジトリ名とホスト名に対応する。 */
export const SERVICE_NAME_EN = 'yaritai100list'

/**
 * サービスを一言で言ったもの。**OGP 画像に載せる**（#229）。
 *
 * 🔴 **`README.md` / `CLAUDE.md` の1行目と同じ文。** 3箇所に別の説明があると、
 * どれが本当なのか分からなくなる。書き換えるならまとめて書き換える。
 */
export const SERVICE_TAGLINE = '100個のやりたいことを書き溜めて、叶えたら印を付けるアプリ。'

/**
 * トップページの説明文（`<meta name="description">` と `og:description`）。
 *
 * ⚠️ **`apps/web/index.html` にも同じ文が書いてある。**
 * あちらは静的な HTML なので、この定数を読めない
 * （SPA は Worker を通さずに配信される。`wrangler.jsonc` の `run_worker_first`）。
 * **ずれていないことはテストで固定してある**（`test/index-html.test.ts`）。
 */
export const SERVICE_DESCRIPTION = `${SERVICE_TAGLINE}ログインせずに書き始められ、ログインするとリストを複数持てて、人に共有できます。`

/**
 * リストの既定タイトル。
 *
 * サービス名「やりたいことリスト100」と紛れないよう、頭に「人生で」を付けている
 * （`PRODUCT_SPEC.md` §7 未決 #10 への対応）。
 *
 * 12文字あり `LIST_TITLE_MAX_LENGTH`（15）に収まっているが余裕は3文字。
 * 上限を下げるときはここが先に破れる（テストで固定してある）。
 */
export const DEFAULT_LIST_TITLE = '人生でやりたいことリスト'

/**
 * 一覧から**2つ目以降を作った**ときの既定タイトル（2026-08-07 決定、#110）。
 *
 * `DEFAULT_LIST_TITLE` と分けているのは、**使う場面が違う**ため。
 * あちらは「最初の1つ」（未ログインで書き始めたときと、その取り込み）に付く名前で、
 * 一生分のリストという意味を持たせている。こちらは用途別に増やす2つ目以降なので、
 * **中身が決まっていないことが分かる名前**にする。
 *
 * 12文字。`LIST_TITLE_MAX_LENGTH`（15）に収まることはテストで固定してある。
 */
export const NEW_LIST_TITLE = '新しいやりたいことリスト'
