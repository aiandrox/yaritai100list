import { describe, expect, it } from 'vitest'

import { scrubEvent, sentryOptions } from '../src/sentry'

describe('sentryOptions', () => {
  it('DSN が無ければ undefined を返す（＝SDK を初期化しない）', () => {
    // ローカル開発では .dev.vars に SENTRY_DSN を置かないので、この経路を通る
    expect(sentryOptions({})).toBeUndefined()
  })

  it('DSN があれば設定を返す。性能データは送らない', () => {
    const options = sentryOptions({ SENTRY_DSN: 'https://key@example.ingest.sentry.io/1' })

    expect(options?.dsn).toBe('https://key@example.ingest.sentry.io/1')

    // 無料枠は 5,000 errors/月で他プロジェクトと共有している。
    // 性能データで枠を食うと障害に気づけなくなる
    expect(options?.tracesSampleRate).toBe(0)
  })

  it('収集するデータを明示的に切っている（既定は収集する側）', () => {
    const options = sentryOptions({ SENTRY_DSN: 'https://key@example.ingest.sentry.io/1' })

    // httpBodies を省略すると全種類のボディが収集される。
    // やりたいことの本文が送られてしまうので空配列で無効にする
    expect(options?.dataCollection?.httpBodies).toEqual([])
    expect(options?.dataCollection?.cookies).toBe(false)
    expect(options?.dataCollection?.httpHeaders).toEqual({ request: false, response: false })
    expect(options?.dataCollection?.userInfo).toBe(false)
  })

  it('environment は既定で production、指定があればそれを使う', () => {
    const dsn = 'https://key@example.ingest.sentry.io/1'

    expect(sentryOptions({ SENTRY_DSN: dsn })?.environment).toBe('production')
    expect(sentryOptions({ SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'local' })?.environment).toBe(
      'local',
    )
  })
})

describe('scrubEvent', () => {
  it('リクエストボディを落とす（やりたいことの本文が入る）', () => {
    const event = {
      request: {
        url: 'https://example.com/api/lists/abc/items',
        data: { text: '富士山に登る' },
      },
    }

    const scrubbed = scrubEvent(event)

    expect(scrubbed.request.data).toBeUndefined()
    expect(JSON.stringify(scrubbed)).not.toContain('富士山に登る')
  })

  it('Cookie とヘッダを落とす（セッションが入る）', () => {
    const event = {
      request: {
        cookies: { session: 'secret-session-token' },
        headers: { cookie: 'session=secret-session-token', 'user-agent': 'x' },
      },
    }

    const scrubbed = scrubEvent(event)

    expect(scrubbed.request.cookies).toBeUndefined()
    expect(scrubbed.request.headers).toBeUndefined()
    expect(JSON.stringify(scrubbed)).not.toContain('secret-session-token')
  })

  it('ユーザー情報を落とす', () => {
    const scrubbed = scrubEvent({ user: { id: 'user-1', email: 'a@example.com' } })

    expect(scrubbed.user).toBeUndefined()
  })

  it('URL は残す（shareId を隠さない方針）', () => {
    const url = 'https://example.com/share/AbCdEfGhIjKlMnOp?v=1785982628293'

    const scrubbed = scrubEvent({ request: { url } })

    expect(scrubbed.request.url).toBe(url)
  })

  it('request が無いイベントでも壊れない', () => {
    expect(() => scrubEvent({})).not.toThrow()
  })
})
