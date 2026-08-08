import { assertEquals, assertStringIncludes } from '@std/assert'

import {
  EXPORT_IMAGE_SIGNATURE_HEADER,
  signExportImagePayload,
  signOgPayload,
  type ExportImagePayload,
  type OgPayload,
} from '../../packages/shared/src/index.ts'

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

Deno.test('描かなかった理由がログに残る（応答には出さない）', async () => {
  // ⚠️ 「期限切れ」と「署名が合わない」は原因も対処も違う。
  // 区別が付かず、**両側の鍵が違うのを見つけるのに時間がかかった**（#184）
  const written: string[] = []
  const original = console.error
  console.error = (message: unknown) => written.push(String(message))

  try {
    const expired = await requestFor(payload({ exp: Math.floor(Date.now() / 1000) - 1 }))
    const wrongKey = await requestFor(payload(), {
      signature: await signOgPayload(payload(), 'another-secret'),
    })

    assertStringIncludes(written[0] ?? '', '期限')
    assertStringIncludes(written[1] ?? '', '署名')

    // 🔴 応答は変えない。理由を返すと、叩く側に手がかりを与える
    assertEquals(await expired.text(), 'Forbidden')
    assertEquals(await wrongKey.text(), 'Forbidden')
  } finally {
    console.error = original
  }
})

Deno.test('🔴 ログに署名を書かない', async () => {
  // 残っていると、そこから叩けるようになる
  const data = payload()
  const signature = await signOgPayload(data, SECRET)

  const written: string[] = []
  const original = console.error
  console.error = (message: unknown) => written.push(String(message))

  try {
    await requestFor({ ...data, title: '書き換えたタイトル' }, { signature })
  } finally {
    console.error = original
  }

  for (const line of written) {
    assertEquals(line.includes(signature), false)
    assertEquals(line.includes(SECRET), false)
  }
})

/**
 * 画像出力（#191）。**POST。本文に署名する。**
 *
 * 🔴 見るのは OGP と同じ **「署名が合わないものを描かないこと」。**
 * 経路が増えても、抜けたら踏み台になるのは変わらない。
 */

function exportPayload(overrides: Partial<ExportImagePayload> = {}): ExportImagePayload {
  return {
    title: '人生でやりたいことリスト',
    items: [
      { text: '南極に行く', completed: true },
      { text: 'オーロラを見る', completed: false },
    ],
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  }
}

async function exportRequest(
  data: ExportImagePayload,
  options: { signature?: string; method?: string; headers?: Record<string, string> } = {},
) {
  const body = JSON.stringify(data)

  return handler(
    new Request('http://localhost/export', {
      method: options.method ?? 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).length),
        [EXPORT_IMAGE_SIGNATURE_HEADER]:
          options.signature ?? (await signExportImagePayload(data, SECRET)),
        ...options.headers,
      },
      body,
    }),
  )
}

Deno.test('署名が合えば PNG を返す', async () => {
  const res = await exportRequest(exportPayload())

  assertEquals(res.status, 200)
  assertEquals(res.headers.get('content-type'), 'image/png')

  const head = new Uint8Array(await res.arrayBuffer()).slice(0, 4)
  assertEquals([...head], [0x89, 0x50, 0x4e, 0x47])
})

Deno.test('🔴 署名が無ければ描かない', async () => {
  const res = await exportRequest(exportPayload(), { signature: '' })

  assertEquals(res.status, 403)
})

Deno.test('🔴 本文を書き換えると描かない', async () => {
  const data = exportPayload()
  const signature = await signExportImagePayload(data, SECRET)

  const res = await exportRequest({ ...data, title: '書き換えたタイトル' }, { signature })

  assertEquals(res.status, 403)
})

Deno.test('🔴 期限が切れていたら描かない', async () => {
  const expired = exportPayload({ exp: Math.floor(Date.now() / 1000) - 1 })

  assertEquals((await exportRequest(expired)).status, 403)
})

Deno.test('🔴 GET では受け付けない', async () => {
  const res = await handler(new Request('http://localhost/export'))

  assertEquals(res.status, 405)
})

Deno.test('🔴 100件を超える本文は描かない', async () => {
  const item = { text: '南極に行く', completed: false }
  const tooMany = exportPayload({ items: Array.from({ length: 101 }, () => item) })

  assertEquals((await exportRequest(tooMany)).status, 403)
})

Deno.test('🔴 大きすぎる本文は読む前に切る', async () => {
  // 署名は正しくても、読むだけ無駄なので手前で落とす
  const data = exportPayload()
  const res = await exportRequest(data, { headers: { 'content-length': String(200 * 1024) } })

  assertEquals(res.status, 413)
})

Deno.test('壊れた JSON でも落ちない', async () => {
  const res = await handler(new Request('http://localhost/export', { method: 'POST', body: '{' }))

  assertEquals(res.status, 403)
})

Deno.test('描かなかった理由がログに残る（画像出力も）', async () => {
  const written: string[] = []
  const original = console.error
  console.error = (message: unknown) => written.push(String(message))

  try {
    await exportRequest(exportPayload(), { signature: '' })
  } finally {
    console.error = original
  }

  assertStringIncludes(written[0] ?? '', '署名')
})

Deno.test('知らない経路は 404', async () => {
  assertEquals((await handler(new Request('http://localhost/'))).status, 404)
})

Deno.test('生きているかの確認は中身を返さない', async () => {
  const res = await handler(new Request('http://localhost/health'))

  assertEquals(res.status, 200)
  assertEquals(await res.text(), 'ok')
})
