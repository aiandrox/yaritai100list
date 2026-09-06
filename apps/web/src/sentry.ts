import type { CloudflareOptions } from '@sentry/cloudflare'

/**
 * このモジュールが必要とする環境変数。
 *
 * `wrangler types` が生成する `Env` には**含まれない。**
 * 生成元は wrangler.jsonc のバインディングと `.dev.vars` で、
 * シークレットは wrangler.jsonc に書かず、`.dev.vars` は gitignore されているため
 * CI では存在しない（そのままだと CI の型チェックだけが落ちる）。
 *
 * グローバルな `Env` を拡張する形は採らなかった。`interface Env` への宣言マージが
 * この構成（`moduleDetection: "force"`）では効かず、`declare global` でも同じだった。
 * **必要な環境変数をモジュール側で表明する方が、どこで何を要求しているかも明確になる。**
 *
 * ここに書くのは名前と型だけ。値の置き場所はローカルが `.dev.vars`、
 * 本番が `wrangler secret put`（`docs/console-settings.md`）。
 */
export interface SentryEnv {
  /**
   * Sentry の DSN。**シークレット扱い**（このリポジトリは public で、
   * 無料枠が 5,000 errors/月しかないため。`docs/console-settings.md` 参照）。
   *
   * **未設定なら通知は無効になる。** ローカル開発では設定しない。
   */
  readonly SENTRY_DSN?: string

  /**
   * Sentry に送るイベントの environment。未設定なら `production`。
   *
   * ローカルから通知を試すときに設定して、本番のイベントと混ざらないようにする。
   */
  readonly SENTRY_ENVIRONMENT?: string
}

/**
 * 通知に載せてよい情報だけを残す。
 *
 * 落とすもの:
 * - **リクエストボディ。やりたいことの本文が入る**（これがこの関数の主目的）
 * - Cookie とヘッダ。セッションが入る
 * - **ユーザー情報のうち `id` 以外すべて**（メールアドレス、名前、IP、位置情報）
 *
 * 残すもの:
 * - **`user.id`。このサービス上の一意キー**。どの利用者で起きた障害かを追うために送る。
 *   メールアドレスや名前は保存はするが（`PRODUCT_SPEC.md` §3）**通知には送らない**
 * - URL。`shareId` や `listId` が載るが、これは隠さない判断。
 *   ただし**自由入力が URL に乗るルート**（検索クエリなど）を作るときは、
 *   そのパラメータをここで落とすことを検討する。現状 URL に載るのは ID と更新日時だけ
 *
 * `beforeSend` に渡ってくるイベントをそのまま加工して返す。
 * テストしやすいよう純関数として切り出している。
 */
export function scrubEvent<T extends { request?: unknown; user?: unknown }>(event: T): T {
  const request = event.request as
    { data?: unknown; cookies?: unknown; headers?: unknown } | undefined

  if (request) {
    delete request.data
    delete request.cookies
    delete request.headers
  }

  // `user` を丸ごと消すと `setUser({ id })` で入れた値も捨ててしまう。
  // **`id` だけを残し、他は名前が何であれ落とす**（SDK や Sentry 側が
  // 増やしたフィールドを個別に列挙しなくて済む）。
  const user = event.user as { id?: unknown } | undefined
  if (user) {
    event.user = user.id === undefined ? undefined : { id: user.id }
  }

  return event
}

/**
 * 画像を出せなかったことを通知する間隔（#290）。
 *
 * 🔴 **毎回は送れない。** 無料枠は 5,000 errors/月で、しかも**他のプロジェクトと共有**
 * （`docs/console-settings.md`）。OGP（`/og/:shareId`）は**公開のルート**なので、
 * 生成サービスが落ちている間にクローラが叩くと、**1回の障害で枠を焼き切る。**
 *
 * ⚠️ **Sentry がまとめてくれるのは «表示» だけ。** 枠を数えるのはイベントの数なので、
 * 同じ内容でも送った分だけ減る。
 */
export const RENDER_FAILURE_COOLDOWN_MS = 10 * 60 * 1000

/**
 * いま通知してよいか（#290）。
 *
 * **一度も送っていない**か、**前に送ってから間隔が空いている**なら送る。
 * 落ちている間ずっと鳴らす必要は無い。**気づければ十分。**
 */
export function shouldReportRenderFailure(now: number, lastReportedAt: number | null): boolean {
  return lastReportedAt === null || now - lastReportedAt >= RENDER_FAILURE_COOLDOWN_MS
}

/**
 * Sentry の設定。`withSentry` に渡す。
 *
 * **DSN が無ければ `undefined` を返して SDK を初期化しない。**
 * ローカル開発では `.dev.vars` に `SENTRY_DSN` を置かないので通知は飛ばない
 * （置けばローカルからも飛ぶ。その場合は `SENTRY_ENVIRONMENT` を設定して
 * 本番のイベントと混ざらないようにする）。
 */
export function sentryOptions(env: SentryEnv): CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined

  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? 'production',

    // 🔴 **収集する側が既定**なので、明示的に切る。
    // `cookies` は既定 true、`httpHeaders` は既定 request/response とも true、
    // `httpBodies` は省略すると**全種類のボディを収集する**
    // （= やりたいことの本文が送られる）。
    //
    // `beforeSend` でも落としているが、設定と二重にしておく。
    // 片方だけに頼ると、SDK の更新で既定が変わったときに黙って漏れる。
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],

      // URL のクエリは送る。`shareId` を隠さない方針に合わせている。
      // 現状クエリに載るのは OGP の `?v=<updatedAt>` だけ。
      // **自由入力（検索語など）をクエリに載せるルートを作るときは false にする。**
      urlQueryParams: true,
    },

    // 性能データは送らない。**無料枠は 5,000 errors/月で、しかも他プロジェクトと
    // 共有している**（docs/console-settings.md）。枠を焼くと障害に気づけなくなる
    tracesSampleRate: 0,

    beforeSend: (event) => scrubEvent(event),
  }
}
