import { exports } from 'cloudflare:workers'
import type { CompletedPrecision } from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { createTestUser, testBaseUrl, testDb } from './helpers'

/**
 * 共有公開ページのテスト（#137）。
 *
 * 🔴 見るのは **「見えてはいけないものが見えないこと」** が中心。
 * 公開の判定はサーバー側にしかない（`CLAUDE.md` の不変条件）。
 */

const request = (path: string) => exports.default.fetch(new Request(`${testBaseUrl()}${path}`))

/** 公開範囲を指定してリストを1つ作る。 */
async function createList(options: {
  visibility: 'private' | 'unlisted' | 'public'
  title?: string
  shareId?: string
  email?: string
}) {
  const db = testDb()
  const userId = await createTestUser(options.email ?? `${crypto.randomUUID()}@example.com`)
  const id = crypto.randomUUID()
  const shareId = options.shareId ?? crypto.randomUUID().replaceAll('-', '')

  await db.insert(lists).values({
    id,
    userId,
    title: options.title ?? '2026年の目標',
    shareId,
    visibility: options.visibility,
  })

  return { id, shareId, userId }
}

/**
 * 粒度（#279）は**省略できる。日時があれば `day`。**
 * 日付なしの完了・年だけの完了を作るときは明示する。
 */
async function addItems(
  listId: string,
  rows: {
    text: string
    completedAt?: Date
    completedPrecision?: CompletedPrecision
    hiddenInShare?: boolean
    memo?: string
  }[],
) {
  await testDb()
    .insert(items)
    .values(
      rows.map((row, position) => ({
        id: crypto.randomUUID(),
        listId,
        text: row.text,
        position,
        completedAt: row.completedAt ?? null,
        completedPrecision:
          row.completedPrecision ?? (row.completedAt === undefined ? null : 'day'),
        hiddenInShare: row.hiddenInShare ?? false,
        memo: row.memo ?? null,
      })),
    )
}

describe('公開されているリスト', () => {
  it('リンク限定公開なら見える', async () => {
    const list = await createList({ visibility: 'unlisted' })
    await addItems(list.id, [{ text: '南極に行く' }])

    const res = await request(`/share/${list.shareId}`)
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(body).toContain('2026年の目標')
    expect(body).toContain('南極に行く')
  })

  it('全公開でも見える（リストの見え方は同じ）', async () => {
    const list = await createList({ visibility: 'public' })

    expect((await request(`/share/${list.shareId}`)).status).toBe(200)
  })

  it('完了マークと完了日時が出る', async () => {
    const list = await createList({ visibility: 'unlisted' })
    await addItems(list.id, [
      { text: '南極に行く', completedAt: new Date('2026-05-01T00:00:00.000Z') },
      { text: 'オーロラを見る' },
    ])

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).toContain('done')
    // 日本時間で描く（サーバーは閲覧者の時間帯を知らない）
    expect(body).toContain('2026/05/01')
    expect(body).toContain('1 / 2 達成')
  })

  /** 粒度（#279）。**出す単位が粒度どおりであること** */
  describe('完了日の粒度（#279）', () => {
    it('年だけ・年月だけの完了は、その単位で出る', async () => {
      const list = await createList({ visibility: 'unlisted', title: 'テスト用のリスト' })
      await addItems(list.id, [
        // 2026-01-01 00:00 JST / 2026-08-01 00:00 JST
        {
          text: '年だけ',
          completedAt: new Date('2025-12-31T15:00:00.000Z'),
          completedPrecision: 'year',
        },
        {
          text: '年月だけ',
          completedAt: new Date('2026-07-31T15:00:00.000Z'),
          completedPrecision: 'month',
        },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('2026年<')
      expect(body).toContain('2026年8月<')
      expect(body).toContain('2 / 2 達成')
    })

    it('🔴 日付なしの完了は、達成数に入るが日付の欄が出ない', async () => {
      const list = await createList({ visibility: 'unlisted', title: 'テスト用のリスト' })
      await addItems(list.id, [
        { text: '日付なしで達成', completedPrecision: 'unknown' },
        { text: '未達成' },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('1 / 2 達成')
      expect(body).toContain('done')
      // 完了は打ち消し線と達成数が伝える。日付の欄そのものを出さない
      expect(body).not.toContain('class="date"')
    })
  })

  it('項目を並び順で出す', async () => {
    const list = await createList({ visibility: 'unlisted' })
    await addItems(list.id, [{ text: '1つ目' }, { text: '2つ目' }])

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body.indexOf('1つ目')).toBeLessThan(body.indexOf('2つ目'))
  })

  it('🔴 読み取り専用。編集の入口を出さない', async () => {
    const list = await createList({ visibility: 'unlisted' })
    await addItems(list.id, [{ text: '南極に行く' }])

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).not.toContain('<form')
    expect(body).not.toContain('<input')
    expect(body).not.toContain('<button')
  })

  it('🔴 作者の情報が一切含まれない', async () => {
    // PRODUCT_SPEC.md §5.1。どの公開面にも作者を出さない
    const list = await createList({ visibility: 'public', email: 'owner@example.com' })
    await addItems(list.id, [{ text: '南極に行く' }])

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).not.toContain('owner@example.com')
    expect(body).not.toContain(list.userId)
  })

  it('🔴 編集用の ID が含まれない', async () => {
    // 公開ページから編集用の URL を推測させない（TECH_STACK.md §7）
    const list = await createList({ visibility: 'public' })

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).not.toContain(list.id)
  })

  it('🔴 利用者が書いた文字がそのまま HTML にならない', async () => {
    const list = await createList({ visibility: 'public', title: '<script>alert(1)</script>' })
    await addItems(list.id, [{ text: '<img src=x onerror=alert(1)>' }])

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).not.toContain('<img src=x')
    expect(body).toContain('&lt;script&gt;')
  })

  it('検索に載せない', async () => {
    // 「URL を知っている人だけ」が前提なので、たどり着ける経路を増やさない
    const list = await createList({ visibility: 'public' })

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).toContain('noindex')
  })

  /**
   * OGP 画像（#173）。
   *
   * 🔴 見るのは **「更新すると URL が変わること」。**
   * SNS は画像を強くキャッシュするので、ここが効いていないと
   * **更新しても古い画像が出続ける**（しかもこちらからは消せない）。
   */
  describe('OGP 画像', () => {
    /** `og:image` に書かれた URL を取り出す。 */
    function imageUrlIn(body: string): string | null {
      return /<meta property="og:image" content="([^"]+)"/.exec(body)?.[1] ?? null
    }

    it('URL に更新日時が入っている', async () => {
      const list = await createList({ visibility: 'public' })

      const url = imageUrlIn(await (await request(`/share/${list.shareId}`)).text())
      const [row] = await testDb().select().from(lists).where(eq(lists.id, list.id))

      expect(url).toBe(`${testBaseUrl()}/og/${list.shareId}?v=${String(row?.updatedAt.getTime())}`)
    })

    it('🔴 リストを更新すると URL が変わる', async () => {
      const list = await createList({ visibility: 'public' })

      const before = imageUrlIn(await (await request(`/share/${list.shareId}`)).text())

      await testDb()
        .update(lists)
        .set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(lists.id, list.id))

      const after = imageUrlIn(await (await request(`/share/${list.shareId}`)).text())

      expect(before).not.toBeNull()
      expect(after).not.toBe(before)
    })

    it('画像があるので大きいカードにする', async () => {
      const list = await createList({ visibility: 'public' })

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('content="summary_large_image"')
    })

    it('🔴 見つからないページには画像を出さない', async () => {
      // 存在しないリストの画像は作れない。
      // 枠だけ空いたカードになるので、カードの種類も戻す
      const body = await (await request('/share/no-such-share-id')).text()

      expect(body).not.toContain('og:image')
      expect(body).toContain('content="summary"')
    })
  })

  it('項目が0件でも壊れない', async () => {
    const list = await createList({ visibility: 'unlisted' })

    const res = await request(`/share/${list.shareId}`)

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('0 / 0 達成')
  })

  describe('自分のリストを作る導線（#225）', () => {
    it('下にトップへのリンクが出る', async () => {
      const list = await createList({ visibility: 'unlisted' })
      await addItems(list.id, [{ text: '南極に行く' }])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('自分のリストを作る')
      // リストの後に出す。**人のリストの続きに見せない**
      expect(body.indexOf('自分のリストを作る')).toBeGreaterThan(body.indexOf('南極に行く'))
    })

    it('🔴 ログインの導線にしない（未ログインでもその場で書けるのが売り）', async () => {
      // 入口でログインを要求したら PRODUCT_SPEC.md §1 が台無しになる
      const list = await createList({ visibility: 'public' })

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).not.toContain('/api/login')
      expect(body).not.toContain('ログイン')
    })

    it('🔴 「見つかりません」には出さない（外した理由を伝える場面で宣伝しない）', async () => {
      const body = await (await request('/share/no-such-share-id')).text()

      expect(body).not.toContain('自分のリストを作る')
    })
  })
})

describe('見えてはいけないもの', () => {
  /**
   * 🔴 **メモは自分だけが読むもの**（#294、`PRODUCT_SPEC.md` §4.4 の表）。
   *
   * 共有ページの `SharedItem` は本文と完了だけを持つ形なので構造上載らないが、
   * **「載せてもよいもの」を後から足すときにここが歯止めになる。**
   */
  it('🔴 メモは共有ページに出ない', async () => {
    const list = await createList({ visibility: 'public' })
    await addItems(list.id, [{ text: '南極に行く', memo: 'ここは自分だけのメモ' }])

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).toContain('南極に行く')
    expect(body).not.toContain('ここは自分だけのメモ')
  })

  it('🔴 完了した項目でもメモは出ない（叶えたときのことを書く場所なので）', async () => {
    const list = await createList({ visibility: 'unlisted' })
    await addItems(list.id, [
      {
        text: '富士山に登る',
        completedAt: new Date('2026-08-01T00:00:00.000Z'),
        memo: 'ご来光が見えた',
      },
    ])

    const body = await (await request(`/share/${list.shareId}`)).text()

    expect(body).toContain('富士山に登る')
    expect(body).not.toContain('ご来光が見えた')
  })

  it('🔴 非公開は share_id を知っていても見えない', async () => {
    const list = await createList({ visibility: 'private' })
    await addItems(list.id, [{ text: '見えてはいけない' }])

    const res = await request(`/share/${list.shareId}`)
    const body = await res.text()

    expect(res.status).toBe(404)
    expect(body).not.toContain('見えてはいけない')
    expect(body).not.toContain('2026年の目標')
  })

  it('🔴 非公開と、存在しない ID で応答が完全に一致する', async () => {
    // 出し分けると「その ID は存在するが非公開」と分かってしまう
    const list = await createList({ visibility: 'private' })

    const hidden = await request(`/share/${list.shareId}`)
    const missing = await request('/share/no-such-share-id')

    expect(hidden.status).toBe(missing.status)
    expect(await hidden.text()).toBe(await missing.text())
  })

  it('🔴 再発行した後は、古い URL から見えない', async () => {
    const list = await createList({ visibility: 'public', shareId: 'old-share-id' })
    await addItems(list.id, [{ text: '南極に行く' }])

    expect((await request('/share/old-share-id')).status).toBe(200)

    await testDb().update(lists).set({ shareId: 'new-share-id' }).where(eq(lists.id, list.id))

    expect((await request('/share/old-share-id')).status).toBe(404)
    expect((await request('/share/new-share-id')).status).toBe(200)
  })

  it('🔴 非公開に戻すと見えなくなる', async () => {
    const list = await createList({ visibility: 'public' })

    expect((await request(`/share/${list.shareId}`)).status).toBe(200)

    await testDb().update(lists).set({ visibility: 'private' }).where(eq(lists.id, list.id))

    expect((await request(`/share/${list.shareId}`)).status).toBe(404)
  })

  it('🔴 編集用の ID を渡しても見えない', async () => {
    // share_id で引いているので当たらない。面が分かれていることの確認
    const list = await createList({ visibility: 'public' })

    expect((await request(`/share/${list.id}`)).status).toBe(404)
  })

  /**
   * 項目ごとに本文を伏せる（#237）。
   *
   * 🔴 見るのは**本文が HTML に一切乗らないこと**。CSS で隠しているだけなら
   * ページのソースを見れば読めてしまうので、`renderSharePage` に渡す前に
   * 本文そのものを落としていることをここで固定する。
   */
  describe('項目ごとに本文を伏せる（#237）', () => {
    it('隠した項目の本文は HTML に含まれず、代わりにプレースホルダーが出る', async () => {
      const list = await createList({ visibility: 'public' })
      await addItems(list.id, [
        { text: '転職する', hiddenInShare: true },
        { text: 'オーロラを見る' },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).not.toContain('転職する')
      expect(body).toContain('（非公開）')
      expect(body).toContain('オーロラを見る')
    })

    it('番号は詰めない。隠した項目もその位置に出る', async () => {
      const list = await createList({ visibility: 'public' })
      await addItems(list.id, [
        { text: '1つ目' },
        { text: '2つ目（隠す）', hiddenInShare: true },
        { text: '3つ目' },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('001')
      expect(body).toContain('002')
      expect(body).toContain('003')
      // 隠した項目の番号（002）の直後にプレースホルダーが来ることを見て、
      // 「隠した項目が消えて番号が詰まった」のではないことを確かめる
      expect(body.indexOf('002')).toBeLessThan(body.indexOf('（非公開）'))
    })

    it('隠していても、達成していれば達成数に入り「done」の見た目も出る', async () => {
      const list = await createList({ visibility: 'public' })
      await addItems(list.id, [
        {
          text: '隠して達成',
          completedAt: new Date('2026-05-01T00:00:00.000Z'),
          hiddenInShare: true,
        },
        { text: '未達成' },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('1 / 2 達成')
      expect(body).toContain('done')
    })

    it('隠した項目の完了日時は出ない', async () => {
      // 🔴 既定のタイトル（'2026年の目標'）自体に年が入るので、日付の有無だけを見られるよう
      // タイトルを変えておく
      const list = await createList({ visibility: 'public', title: 'テスト用のリスト' })
      await addItems(list.id, [
        {
          text: '隠して達成',
          completedAt: new Date('2026-05-01T00:00:00.000Z'),
          hiddenInShare: true,
        },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).not.toContain('2026')
    })

    // 🔴 粒度も伏せる（#279）。「2026年」だけでも「いつ」の情報
    it('隠した項目は、年だけの完了でも年が出ない', async () => {
      const list = await createList({ visibility: 'public', title: 'テスト用のリスト' })
      await addItems(list.id, [
        {
          text: '隠して達成',
          completedAt: new Date('2025-12-31T15:00:00.000Z'),
          completedPrecision: 'year',
          hiddenInShare: true,
        },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('1 / 1 達成')
      expect(body).not.toContain('2026')
    })

    it('隠していない項目は今までどおり本文と完了日時が出る（回帰確認）', async () => {
      const list = await createList({ visibility: 'public' })
      await addItems(list.id, [
        { text: '隠さない達成', completedAt: new Date('2026-05-01T00:00:00.000Z') },
      ])

      const body = await (await request(`/share/${list.shareId}`)).text()

      expect(body).toContain('隠さない達成')
      expect(body).toContain('2026')
    })
  })
})
