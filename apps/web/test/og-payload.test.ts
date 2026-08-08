import {
  LIST_TITLE_MAX_LENGTH,
  OG_SIGNATURE_TTL_SECONDS,
  ogPayloadSchema,
  signOgPayload,
  verifyOgPayload,
  type OgPayload,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

/**
 * OGP に渡すデータと署名のテスト（#170）。
 *
 * 署名は Cloudflare Workers が作り、Deno Deploy が確かめる。
 * **ここで固定するのは「合わないものが通らないこと」。**
 * 通ることだけ確かめても、踏み台にされる経路は塞げない。
 */

const SECRET = 'test-secret-not-used-outside-tests'
const NOW = new Date('2026-08-08T00:00:00.000Z')

function payload(overrides: Partial<OgPayload> = {}): OgPayload {
  return {
    title: '2026年の目標',
    completed: 5,
    filled: 23,
    exp: Math.floor(NOW.getTime() / 1000) + OG_SIGNATURE_TTL_SECONDS,
    ...overrides,
  }
}

describe('ogPayloadSchema', () => {
  it('🔴 作者を入れる場所が無い', () => {
    // どの公開面にも作者を出さない（PRODUCT_SPEC.md §5.1）。
    // 入れる場所が無ければ、間違えて入れることもない
    const withAuthor = { ...payload(), userId: 'someone' }

    expect(ogPayloadSchema.safeParse(withAuthor).success).toBe(false)
  })

  it('🔴 タイトルの長さに上限がある', () => {
    // 画像に描くテキストは長さを制限する（TECH_STACK.md §9）。
    // レイアウト崩れと CPU 消費の両方を防ぐ
    expect(
      ogPayloadSchema.safeParse(payload({ title: 'あ'.repeat(LIST_TITLE_MAX_LENGTH) })).success,
    ).toBe(true)
    expect(
      ogPayloadSchema.safeParse(payload({ title: 'あ'.repeat(LIST_TITLE_MAX_LENGTH + 1) })).success,
    ).toBe(false)
  })

  it('数は負にならない', () => {
    expect(ogPayloadSchema.safeParse(payload({ completed: -1 })).success).toBe(false)
  })
})

describe('署名', () => {
  it('作った署名は通る', async () => {
    const data = payload()
    const signature = await signOgPayload(data, SECRET)

    expect(await verifyOgPayload(data, signature, SECRET, NOW)).toBe(true)
  })

  it('同じ内容なら同じ署名になる（配るキャッシュがぶれない）', async () => {
    expect(await signOgPayload(payload(), SECRET)).toBe(await signOgPayload(payload(), SECRET))
  })

  it('🔴 中身を1つ変えると通らない', async () => {
    const signature = await signOgPayload(payload(), SECRET)

    expect(await verifyOgPayload(payload({ title: '別のタイトル' }), signature, SECRET, NOW)).toBe(
      false,
    )
    expect(await verifyOgPayload(payload({ completed: 6 }), signature, SECRET, NOW)).toBe(false)
    expect(await verifyOgPayload(payload({ filled: 24 }), signature, SECRET, NOW)).toBe(false)
  })

  it('🔴 期限を延ばすと通らない（署名の対象に入っている）', async () => {
    const data = payload()
    const signature = await signOgPayload(data, SECRET)

    expect(await verifyOgPayload({ ...data, exp: data.exp + 1 }, signature, SECRET, NOW)).toBe(
      false,
    )
  })

  it('🔴 期限が切れたら通らない', async () => {
    const data = payload()
    const signature = await signOgPayload(data, SECRET)
    const later = new Date((data.exp + 1) * 1000)

    expect(await verifyOgPayload(data, signature, SECRET, later)).toBe(false)
  })

  it('🔴 鍵が違うと通らない', async () => {
    const data = payload()
    const signature = await signOgPayload(data, SECRET)

    expect(await verifyOgPayload(data, signature, 'another-secret', NOW)).toBe(false)
  })

  it('壊れた署名でも落ちない', async () => {
    const data = payload()

    expect(await verifyOgPayload(data, '', SECRET, NOW)).toBe(false)
    expect(await verifyOgPayload(data, 'zzzz', SECRET, NOW)).toBe(false)
    expect(await verifyOgPayload(data, 'abc', SECRET, NOW)).toBe(false)
  })

  it('🔴 区切りをまたいでも同じ署名にならない', async () => {
    // 連結して署名すると、境目をずらした別の内容が同じ文字列になることがある。
    // タイトルに改行を入れて、それが起きないことを見る
    const a = await signOgPayload(payload({ title: 'あ\n5' }), SECRET)
    const b = await signOgPayload(payload({ title: 'あ', completed: 5 }), SECRET)

    expect(a).not.toBe(b)
  })
})
