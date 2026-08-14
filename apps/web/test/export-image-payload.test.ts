import {
  EXPORT_IMAGE_SIGNATURE_TTL_SECONDS,
  exportImagePayloadSchema,
  isExportImagePayloadExpired,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  LIST_TITLE_MAX_LENGTH,
  signExportImagePayload,
  verifyExportImagePayload,
  type ExportImagePayload,
} from '@yaritai100list/shared'
import { describe, expect, it } from 'vitest'

/**
 * 画像出力に渡すデータと署名のテスト（#189）。
 *
 * 署名は Cloudflare Workers が作り、Deno Deploy が確かめる。
 * **どちらのランタイムにも Web Crypto があるので、ここで両側の挙動を見られる。**
 *
 * 🔴 見るのは **「署名が無い/合わないものを描かせないこと」。**
 * ここが抜けると、誰でも叩けるラスタライズの踏み台になる（`TECH_STACK.md` §9）。
 */

const SECRET = 'test-secret-not-used-outside-tests'
const NOW = new Date('2026-08-08T00:00:00.000Z')

function payload(overrides: Partial<ExportImagePayload> = {}): ExportImagePayload {
  return {
    title: '人生でやりたいことリスト',
    items: [
      { text: '南極に行く', completed: true },
      { text: 'オーロラを見る', completed: false },
    ],
    exp: Math.floor(NOW.getTime() / 1000) + EXPORT_IMAGE_SIGNATURE_TTL_SECONDS,
    ...overrides,
  }
}

describe('exportImagePayloadSchema', () => {
  /**
   * 🔴 **メモは画像に出さない**（#294、`PRODUCT_SPEC.md` §4.4 の表）。
   * 4列×25行の枡に入らないうえ、**人に渡す1枚**なので自分だけのメモを載せない。
   * スキーマが `.strict()` なので、渡そうとした時点で断られる。
   */
  it('🔴 メモを渡せない（画像に出さない）', () => {
    const withMemo = {
      ...payload(),
      items: [{ text: '南極に行く', completed: true, memo: 'ここは自分だけのメモ' }],
    }

    expect(exportImagePayloadSchema.safeParse(withMemo).success).toBe(false)
  })

  it('入力と同じ上限を使う（画像の都合で入力を狭めない）', () => {
    const ok = exportImagePayloadSchema.safeParse(
      payload({ title: 'あ'.repeat(LIST_TITLE_MAX_LENGTH) }),
    )
    const tooLong = exportImagePayloadSchema.safeParse(
      payload({ title: 'あ'.repeat(LIST_TITLE_MAX_LENGTH + 1) }),
    )

    expect(ok.success).toBe(true)
    expect(tooLong.success).toBe(false)
  })

  it('項目の文字数にも上限がある', () => {
    const tooLong = exportImagePayloadSchema.safeParse(
      payload({ items: [{ text: 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1), completed: false }] }),
    )

    expect(tooLong.success).toBe(false)
  })

  it('🔴 100件を超える本文は弾く（描く量を無制限にしない）', () => {
    const item = { text: '南極に行く', completed: false }
    const ok = exportImagePayloadSchema.safeParse(
      payload({ items: Array.from({ length: ITEMS_PER_LIST_MAX }, () => item) }),
    )
    const tooMany = exportImagePayloadSchema.safeParse(
      payload({ items: Array.from({ length: ITEMS_PER_LIST_MAX + 1 }, () => item) }),
    )

    expect(ok.success).toBe(true)
    expect(tooMany.success).toBe(false)
  })

  it('1件も無くても通る（まだ何も書いていないリスト）', () => {
    expect(exportImagePayloadSchema.safeParse(payload({ items: [] })).success).toBe(true)
  })

  it('🔴 知らない項目は弾く（作者を紛れ込ませない）', () => {
    const withAuthor = { ...payload(), author: 'aiandrox' }

    expect(exportImagePayloadSchema.safeParse(withAuthor).success).toBe(false)
  })
})

describe('署名', () => {
  it('署名して確かめると通る', async () => {
    const data = payload()

    expect(
      await verifyExportImagePayload(data, await signExportImagePayload(data, SECRET), SECRET, NOW),
    ).toBe(true)
  })

  it('🔴 タイトルを1文字変えると通らない', async () => {
    const data = payload()
    const signature = await signExportImagePayload(data, SECRET)

    expect(
      await verifyExportImagePayload({ ...data, title: '別のリスト' }, signature, SECRET, NOW),
    ).toBe(false)
  })

  it('🔴 項目を書き換えると通らない', async () => {
    const data = payload()
    const signature = await signExportImagePayload(data, SECRET)
    const tampered = {
      ...data,
      items: [{ text: '書き換えた', completed: true }, ...data.items.slice(1)],
    }

    expect(await verifyExportImagePayload(tampered, signature, SECRET, NOW)).toBe(false)
  })

  it('🔴 「やった」印だけを付け替えても通らない', async () => {
    const data = payload()
    const signature = await signExportImagePayload(data, SECRET)
    const tampered = {
      ...data,
      items: data.items.map((item) => ({ ...item, completed: !item.completed })),
    }

    expect(await verifyExportImagePayload(tampered, signature, SECRET, NOW)).toBe(false)
  })

  it('🔴 項目を1つ消しても通らない', async () => {
    const data = payload()
    const signature = await signExportImagePayload(data, SECRET)

    expect(
      await verifyExportImagePayload(
        { ...data, items: data.items.slice(0, 1) },
        signature,
        SECRET,
        NOW,
      ),
    ).toBe(false)
  })

  it('🔴 期限が切れていると通らない', async () => {
    const data = payload()
    const signature = await signExportImagePayload(data, SECRET)
    const later = new Date((data.exp + 1) * 1000)

    expect(await verifyExportImagePayload(data, signature, SECRET, later)).toBe(false)
  })

  it('🔴 鍵が違うと通らない', async () => {
    const data = payload()
    const signature = await signExportImagePayload(data, SECRET)

    expect(await verifyExportImagePayload(data, signature, 'another-secret', NOW)).toBe(false)
  })

  it('壊れた署名でも落ちない', async () => {
    const data = payload()

    expect(await verifyExportImagePayload(data, '', SECRET, NOW)).toBe(false)
    expect(await verifyExportImagePayload(data, 'zzzz', SECRET, NOW)).toBe(false)
    expect(await verifyExportImagePayload(data, 'abc', SECRET, NOW)).toBe(false)
  })

  it('🔴 区切りをまたいでも同じ署名にならない', async () => {
    // 単に繋いで署名すると、**境目をずらした別の内容が同じ文字列になる。**
    // 入れ子があるぶん og.ts より起きやすいので、項目テキストに区切りを書いて確かめる
    const a = await signExportImagePayload(
      payload({ items: [{ text: 'あ2:い', completed: false }] }),
      SECRET,
    )
    const b = await signExportImagePayload(
      payload({
        items: [
          { text: 'あ', completed: false },
          { text: 'い', completed: false },
        ],
      }),
      SECRET,
    )

    expect(a).not.toBe(b)
  })

  it('🔴 項目の数を書き換えても通らない（件数も署名に入っている）', async () => {
    const one = payload({ items: [{ text: '南極に行く', completed: false }] })
    const two = payload({
      items: [
        { text: '南極に行く', completed: false },
        { text: '', completed: false },
      ],
    })

    expect(await signExportImagePayload(one, SECRET)).not.toBe(
      await signExportImagePayload(two, SECRET),
    )
  })
})

describe('isExportImagePayloadExpired', () => {
  it('期限そのものは切れている扱い', () => {
    const data = payload()

    expect(isExportImagePayloadExpired(data, new Date(data.exp * 1000))).toBe(true)
    expect(isExportImagePayloadExpired(data, new Date(data.exp * 1000 - 1))).toBe(false)
  })

  it('有効期間は OGP より短い（押した直後に1回使うだけ）', () => {
    expect(EXPORT_IMAGE_SIGNATURE_TTL_SECONDS).toBeLessThan(60 * 60)
  })
})
