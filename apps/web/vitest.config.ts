import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * テストは Workers ランタイム（workerd）の中で実行される。Node の中で
 * Workers を模倣するのではないため、**本番と同じランタイムの挙動で検証できる。**
 *
 * D1 はインメモリで、`migrations/` の SQL を適用した状態から始まる。
 * ネットワークもリモートの D1 も使わない。
 *
 * ⚠️ `@cloudflare/vitest-pool-workers` の設定方法は 0.20 で変わっている。
 * 公式ドキュメントや古い記事にある `defineWorkersConfig` /
 * `defineWorkersProject` と `test.poolOptions.workers` は**もう存在しない。**
 * 現在は vitest の `defineConfig` に `plugins: [cloudflareTest(...)]` を渡し、
 * 旧 `poolOptions.workers` の中身をそのまま `cloudflareTest()` の引数にする。
 */
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      /**
       * 🔴 **テスト専用の環境を使う**（#253）。**AI バインディングを避けるため。**
       * 上の環境には AI があり、`vitest-pool-workers` はそれをリモート扱いにして
       * `CLOUDFLARE_API_TOKEN` を要求する。CI にはトークンが無いので**1件も起動しない。**
       */
      wrangler: { configPath: './wrangler.jsonc', environment: 'test' },
      miniflare: {
        // 🔴 wrangler は `.dev.vars` を読むので、テストも手元では
        // ローカルのシークレットを使ってしまう。**CI には `.dev.vars` が無い**ため、
        // ここで固定値を入れておかないと「手元では緑、CI だけ落ちる」状態になる。
        // テスト専用の値であり、本番のシークレットとは無関係。
        bindings: {
          BETTER_AUTH_SECRET: 'test-secret-not-used-outside-tests-0123456789',

          // Google のログイン導線をテストするためのダミー。
          // 認可 URL の組み立てはローカルで完結するのでネットワークには出ない
          GOOGLE_CLIENT_ID: 'dummy-client-id.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'dummy-client-secret',
        },

        /**
         * 🔴 **テストのときだけ枠を小さくする**（#215）。
         *
         * 制限に当たることを確かめるには**枠の数だけ往復するしかない。**
         * 本番の値（作成系60・画像10）のままだと1テストで約61往復し、
         * 3つで約183回。**5秒のタイムアウトを CI で超えて落ちていた。**
         *
         * ⚠️ **枠の値がここと `wrangler.jsonc` の2箇所になる。**
         * そのぶん**テスト側は数を書かない。**
         * 「429 が返るまで叩く」形にしてあるので（`test/rate-limit.test.ts`）、
         * どちらの値を変えてもテストは追随する。
         *
         * 🔴 **作成系を `LISTS_PER_USER_MAX`（5）より十分大きくしておく。**
         * リスト数の上限のテストは1人で6回 POST するので、
         * ここを 6 以下にすると**別のテストが 429 で落ちる。**
         *
         * `namespace_id` は `wrangler.jsonc` と揃える（別の名前空間にしない）。
         */
        ratelimits: {
          CREATE_RATE_LIMIT: { namespace_id: '1001', simple: { limit: 10, period: 60 } },
          IMAGE_RATE_LIMIT: { namespace_id: '1002', simple: { limit: 3, period: 60 } },
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],

    // マイグレーションは miniflare のバインディングではなく provide で渡す。
    // バインディングにするとテスト専用の値を `Env` の型に混ぜる必要があり、
    // 本体のコードからも見えてしまう。相対パスは vitest の root（apps/web）基準。
    provide: { d1Migrations: await readD1Migrations('migrations') },
  },
}))
