import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  SERVICE_DESCRIPTION,
  SERVICE_NAME,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

// 🔴 **中身をここに写さない。** 写した瞬間に3箇所目になる
import indexHtml from '../index.html?raw'
import robotsTxt from '../public/robots.txt?raw'
import wranglerJsonc from '../wrangler.jsonc?raw'

/**
 * トップページのメタタグ（#229）。
 *
 * `index.html` は**静的なファイル**で、`packages/shared` の定数を読めない
 * （SPA は Worker を通らずに配信される。`wrangler.jsonc` の `run_worker_first`）。
 * つまり**サービス名・説明文・オリジンが2箇所に書かれている。**
 *
 * 🔴 **ここが唯一、それがずれていないことを見る場所。**
 * ずれても画面は普通に動くので、テストが無いと**誰も気づけない。**
 */

/** `<meta name="x">` / `<meta property="x">` の content を取る。 */
function meta(name: string): string | null {
  const pattern = new RegExp(
    `<meta\\s+(?:name|property)="${name}"\\s+content="([^"]*)"`,
    // 属性が改行で折り返されている（prettier がそう整える）ことがある
    's',
  )
  const wrapped = new RegExp(
    `<meta\\s*\\n\\s*(?:name|property)="${name}"\\s*\\n\\s*content="([^"]*)"`,
    's',
  )

  return pattern.exec(indexHtml)?.[1] ?? wrapped.exec(indexHtml)?.[1] ?? null
}

/** `wrangler.jsonc` が持っている本番のオリジン。**テスト側に URL を書かない。** */
function productionOrigin(): string {
  const found = /"BETTER_AUTH_URL":\s*"([^"]+)"/.exec(wranglerJsonc)?.[1]
  if (found === undefined) throw new Error('wrangler.jsonc に BETTER_AUTH_URL が無い')

  return found
}

describe('index.html のメタタグ', () => {
  it('🔴 サービス名が service.ts と揃っている', () => {
    expect(indexHtml).toContain(`<title>${SERVICE_NAME}</title>`)
    expect(meta('og:title')).toBe(SERVICE_NAME)
    expect(meta('og:site_name')).toBe(SERVICE_NAME)
  })

  it('🔴 説明文が service.ts と揃っている', () => {
    expect(meta('description')).toBe(SERVICE_DESCRIPTION)
    expect(meta('og:description')).toBe(SERVICE_DESCRIPTION)
  })

  it('🔴 URL が wrangler.jsonc の本番オリジンと揃っている', () => {
    // ずれると、SNS のカードが**別のホストの画像**を取りに行く
    const origin = productionOrigin()

    expect(meta('og:url')).toBe(`${origin}/`)
    expect(meta('og:image')).toBe(`${origin}/og.png`)
  })

  it('🔴 og:image が絶対 URL（相対パスでは読まれない）', () => {
    expect(meta('og:image')?.startsWith('https://')).toBe(true)
  })

  it('画像の大きさが og-template.ts と揃っている', () => {
    expect(meta('og:image:width')).toBe(String(OG_IMAGE_WIDTH))
    expect(meta('og:image:height')).toBe(String(OG_IMAGE_HEIGHT))
  })

  it('🔴 画像があるので大きいカードにする', () => {
    // 画像が無いのに summary_large_image にすると、枠だけが空いたカードになる
    expect(meta('og:image')).not.toBeNull()
    expect(meta('twitter:card')).toBe('summary_large_image')
  })

  it('🔴 canonical を置かない（1枚の HTML が全ルートに出るため）', () => {
    expect(indexHtml).not.toContain('rel="canonical"')
  })

  it('アイコンの参照先が実在する名前になっている', () => {
    expect(indexHtml).toContain('href="/favicon.svg"')
    expect(indexHtml).toContain('href="/apple-touch-icon.png"')
  })
})

describe('robots.txt', () => {
  it('🔴 編集画面と API は巡回させない', () => {
    expect(robotsTxt).toContain('Disallow: /lists/')
    expect(robotsTxt).toContain('Disallow: /api/')
  })

  it('🔴 /share/ は Disallow しない（meta の noindex を読ませるため）', () => {
    // 巡回を止めると noindex が読まれず、URL だけが検索に載ることがある
    expect(robotsTxt).not.toContain('Disallow: /share')
  })

  it('トップは巡回させる', () => {
    expect(robotsTxt).not.toContain('Disallow: /\n')
  })
})
