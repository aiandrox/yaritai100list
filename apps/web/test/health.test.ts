import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

/**
 * `exports.default.fetch` は Worker のエントリポイントを通る。ハンドラを直接
 * 呼ぶのではなくリクエストとして投げるため、**ルーティングとバインディングも
 * 一緒に検証できる。**
 *
 * ⚠️ 古い記事とドキュメントにある `cloudflare:test` の `SELF` は 0.20 で
 * deprecated になった。`cloudflare:workers` の `exports` を使う。
 */
describe('ヘルスチェック', () => {
  it('GET /api/health が ok を返す', async () => {
    const res = await exports.default.fetch(new Request('https://example.com/api/health'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('GET /api/health/db が D1 への往復を通る', async () => {
    const res = await exports.default.fetch(new Request('https://example.com/api/health/db'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' })
  })

  it('定義していないパスは 404 を返す', async () => {
    const res = await exports.default.fetch(new Request('https://example.com/nope'))

    expect(res.status).toBe(404)
  })
})
