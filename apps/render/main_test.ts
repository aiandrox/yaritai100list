import { assertEquals } from '@std/assert'

import { signOgPayload, type OgPayload } from '../../packages/shared/src/index.ts'

/**
 * 画像生成サービスのテスト（#172）。
 *
 * 🔴 見るのは **「署名が合わないものを描かないこと」。**
 * ここが抜けると、誰でも叩けるラスタライズの踏み台になる（`TECH_STACK.md` §9）。
 *
 * ⚠️ **`main.ts` は読み込んだ時点で鍵を要求する**（無ければ落ちる）。
 * だから先に環境変数を入れてから動的に読む。
 */

const SECRET = 'test-secret-not-used-outside-tests'
Deno.env.set('RENDER_HMAC_SECRET', SECRET)

const { handler } = await import('./main.ts')

function payload(overrides: Partial<OgPayload> = {}): OgPayload {
  return {
    title: '2026年の目標',
    completed: 5,
    filled: 23,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }
}

async function requestFor(data: OgPayload, options: { signature?: string } = {}) {
  const params = new URLSearchParams({
    title: data.title,
    completed: String(data.completed),
    filled: String(data.filled),
    exp: String(data.exp),
    sig: options.signature ?? (await signOgPayload(data, SECRET)),
  })

  return handler(new Request(`http://localhost/og?${params.toString()}`))
}

Deno.test('署名が合えば PNG を返す', async () => {
  const res = await requestFor(payload())

  assertEquals(res.status, 200)
  assertEquals(res.headers.get('content-type'), 'image/png')

  // PNG の先頭は決まっている。**中身が画像であることまで見る**
  const head = new Uint8Array(await res.arrayBuffer()).slice(0, 4)
  assertEquals([...head], [0x89, 0x50, 0x4e, 0x47])
})

Deno.test('🔴 署名が無ければ描かない', async () => {
  const res = await handler(new Request('http://localhost/og?title=x&completed=0&filled=0&exp=1'))

  assertEquals(res.status, 403)
})

Deno.test('🔴 中身を書き換えると描かない', async () => {
  const signed = payload()
  const signature = await signOgPayload(signed, SECRET)

  const res = await requestFor({ ...signed, title: '書き換えたタイトル' }, { signature })

  assertEquals(res.status, 403)
})

Deno.test('🔴 期限が切れていたら描かない', async () => {
  const expired = payload({ exp: Math.floor(Date.now() / 1000) - 1 })

  assertEquals((await requestFor(expired)).status, 403)
})

Deno.test('🔴 別の鍵で署名されていたら描かない', async () => {
  const data = payload()
  const signature = await signOgPayload(data, 'another-secret')

  assertEquals((await requestFor(data, { signature })).status, 403)
})

Deno.test('形が違えば描かない（数でない値）', async () => {
  const res = await handler(
    new Request('http://localhost/og?title=x&completed=abc&filled=1&exp=1&sig=00'),
  )

  assertEquals(res.status, 403)
})

Deno.test('知らない経路は 404', async () => {
  assertEquals((await handler(new Request('http://localhost/'))).status, 404)
})

Deno.test('生きているかの確認は中身を返さない', async () => {
  const res = await handler(new Request('http://localhost/health'))

  assertEquals(res.status, 200)
  assertEquals(await res.text(), 'ok')
})
