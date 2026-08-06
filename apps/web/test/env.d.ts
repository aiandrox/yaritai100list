import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare module 'vitest' {
  /**
   * `vitest.config.ts` の `test.provide` で渡す値。テストからは
   * `inject('d1Migrations')` で受け取る。
   *
   * テスト専用の値を miniflare のバインディングにすると `Env` の型に混ぜることになり、
   * 本体のコードからも見えてしまうため、provide 経由にしている。
   */
  interface ProvidedContext {
    d1Migrations: D1Migration[]
  }
}
