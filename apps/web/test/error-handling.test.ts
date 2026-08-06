import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

/**
 * ルート内で例外が起きたときの振る舞い。
 *
 * **Hono は例外を自前で捕まえて 500 を返す**ため、`withSentry` に例外が届かない。
 * `onError` で明示的に Sentry へ送っている（`src/index.ts`）。
 * ここでは `onError` が配線されていることと、レスポンスに内部情報が漏れないことを見る。
 *
 * 通知が実際に届くかはテストでは確認できない（DSN が必要）。
 * 手順は `docs/console-settings.md`。
 */
describe('例外が起きたとき', () => {
  it('500 を返し、例外の内容をレスポンスに載せない', async () => {
    const res = await exports.default.fetch(new Request('https://example.com/api/dev/boom'))

    expect(res.status).toBe(500)

    const body = await res.text()
    expect(body).toBe(JSON.stringify({ error: 'Internal Server Error' }))
    expect(body).not.toContain('Sentry の到達確認')
  })
})
