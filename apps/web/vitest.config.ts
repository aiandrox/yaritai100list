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
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // 🔴 wrangler は `.dev.vars` を読むので、テストも手元では
        // ローカルのシークレットを使ってしまう。**CI には `.dev.vars` が無い**ため、
        // ここで固定値を入れておかないと「手元では緑、CI だけ落ちる」状態になる。
        // テスト専用の値であり、本番のシークレットとは無関係。
        bindings: { BETTER_AUTH_SECRET: 'test-secret-not-used-outside-tests-0123456789' },
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
