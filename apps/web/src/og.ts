import { OG_SIGNATURE_TTL_SECONDS, type OgPayload } from '@yaritai100list/shared'

/**
 * OGP 画像の入口（#171）。**認可はここで済ませる。**
 *
 * 🔴 **生成サービスに公開/非公開を判断させない**（`CLAUDE.md` の不変条件）。
 * 「画像だけ漏れる」は典型的な事故なので、共有ページ（#137）と**同じ判定**を通してから、
 * 描くデータだけを署名して渡す。
 */

/**
 * ⚠️ **`RENDER_URL` はここに無い。** 秘密ではないので `wrangler.jsonc` の `vars` にあり、
 * 型は `wrangler types` が `Env` に生成する（`BETTER_AUTH_URL` と同じ扱い）。
 * 設定をコードに乗せておく、という方針（`TECH_STACK.md` §1）。
 *
 * **消すと型エラーになる**ので、消したことに気づける。
 */
export interface RenderEnv {
  /**
   * 生成サービスと共有する鍵。**両側で同じ値**（`docs/console-settings.md`）。
   *
   * 未設定なら画像を出さない。**署名なしで叩ける状態を作らない**
   * （放置すると CPU 枠を溶かす踏み台になる。`TECH_STACK.md` §9）。
   */
  readonly RENDER_HMAC_SECRET?: string
}

/**
 * 画像に描くデータを組み立てる。**純関数**（`TECH_STACK.md` §10）。
 *
 * 渡すのは**タイトルと達成状況だけ。** 作者も項目の一覧も入れない
 * （`PRODUCT_SPEC.md` §5.2。そもそも `OgPayload` に入れる場所が無い）。
 *
 * 達成状況の分母は**書いた数**。画面（#168）とマークダウン（#129）と揃えてある。
 */
export function buildOgPayload(
  list: { title: string },
  items: { completedAt: Date | null }[],
  now: Date,
): OgPayload {
  return {
    title: list.title,
    completed: items.filter((item) => item.completedAt !== null).length,
    filled: items.length,
    exp: Math.floor(now.getTime() / 1000) + OG_SIGNATURE_TTL_SECONDS,
  }
}

/**
 * 共有ページの `og:image` に書く URL（#173）。
 *
 * 🔴 **更新日時を `v` に入れる。** SNS は画像を強くキャッシュするので、
 * URL が変わらないと**リストを更新しても古い画像が出続ける。**
 * 逆に `v` が付いていることで、こちらは恒久キャッシュにできる（`cacheControlFor`）。
 *
 * ⚠️ **絶対 URL にする。** SNS は相対パスを解決しない。
 */
export function ogImageUrl(origin: string, shareId: string, updatedAt: Date): string {
  return `${origin}/og/${shareId}?v=${String(updatedAt.getTime())}`
}

/**
 * 生成サービスに投げる URL。**GET にしてあるのは、あちら側でもキャッシュが効くから。**
 */
export function renderRequestUrl(base: string, payload: OgPayload, signature: string): string {
  const params = new URLSearchParams({
    title: payload.title,
    completed: String(payload.completed),
    filled: String(payload.filled),
    exp: String(payload.exp),
    sig: signature,
  })

  return `${base.replace(/\/$/, '')}/og?${params.toString()}`
}

/**
 * 画像のキャッシュの指示。
 *
 * 🔴 **`v` が付いているときだけ恒久キャッシュにする**（#8 のコメント）。
 * リストを更新すると `v` が変わって別の URL になるので、古い画像が残らない。
 *
 * `v` が無い URL は**誰が作ったものか分からない**（手で叩かれた、古いリンク）。
 * 恒久キャッシュにすると更新しても直らなくなるので、短くしておく。
 */
export function cacheControlFor(version: string | undefined): string {
  return version === undefined || version === ''
    ? 'public, max-age=300'
    : 'public, max-age=31536000, immutable'
}
