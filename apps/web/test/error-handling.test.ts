import { env } from 'cloudflare:workers'
import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

/**
 * ルート内で例外が起きたときの振る舞い。
 *
 * **Hono は例外を自前で捕まえて 500 を返す**ため、`withSentry` だけでは
 * 通知が飛ばない可能性がある。`onError` で明示的に Sentry へ送っている
 * （`src/index.ts`）。ここでは 500 になることと、**例外の内容が
 * レスポンスに漏れないこと**を見る。
 *
 * 例外を起こす専用のルートは置かない。恒久的に置くと公開されたエラー発生器になり、
 * 無料枠（5,000 errors/月、他プロジェクトと共有）を焼かれる。
 * 代わりにテーブルを落として、本物の失敗経路を通す。
 *
 * 通知が実際に届くことは 2026-08-06 に本番で確認済み
 * （手順と結果は `docs/console-settings.md`）。
 */
describe('例外が起きたとき', () => {
  it('500 を返し、例外の内容をレスポンスに載せない', async () => {
    // D1 のクエリが失敗する状況を作る。onError を通る本物の経路になる
    await env.DB.prepare('drop table lists').run()

    const res = await exports.default.fetch(new Request('https://example.com/api/health/db'))

    expect(res.status).toBe(500)

    const body = await res.text()
    expect(body).toBe(JSON.stringify({ error: 'Internal Server Error' }))

    // SQL やテーブル名などの内部情報が漏れていないこと
    expect(body).not.toContain('lists')
    expect(body).not.toContain('D1')
    expect(body).not.toContain('SQL')
  })
})
