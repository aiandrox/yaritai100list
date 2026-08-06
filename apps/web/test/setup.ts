import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, inject } from 'vitest'

import { resetDb } from './helpers'

/**
 * インメモリの D1 にマイグレーションを当てる。テストファイルごとに1回走る。
 *
 * `env` は `cloudflare:workers` から取る。`cloudflare:test` も `env` を
 * 再エクスポートしているが 0.20 で deprecated になった。
 */
await applyD1Migrations(env.DB, inject('d1Migrations'))

/**
 * **各テストの前にデータを消す。**
 *
 * `@cloudflare/vitest-pool-workers` の README は "isolated per-test storage" を
 * 謳っており、0.19 までは `poolOptions.workers.isolatedStorage` でテストごとに
 * 状態が巻き戻った。**0.20 でこのオプションは無くなっている**
 * （`WorkersPoolOptions` の定義に存在しない）。実際の分離はテストファイル単位で、
 * 同じファイル内のテストは前のテストが書いた行を見てしまう。
 *
 * 公式ドキュメントや学習データは古い前提のままなので、**ライブラリの機能に頼らず
 * ここで明示的に消す。** setupFiles に置いてあるので、テストファイルを増やしても
 * 書き忘れが起きない。
 */
beforeEach(async () => {
  await resetDb()
})
