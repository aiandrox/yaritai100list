import { exports } from 'cloudflare:workers'
import { DISCOVER_MAX_PAGE, DISCOVER_PAGE_SIZE } from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { rebuildPool } from '../src/pool'
import { signIn, testBaseUrl, testDb } from './helpers'
import { makeList, runBatch } from './pool-helpers'

/**
 * 取り入れ面のプールのテスト（#233 / #254、親 #10）。
 *
 * 🔴 見るのは3つ。
 *
 * - **出てはいけない本文が出ないこと**（認可。`docs/workflow.md` §6）。
 *   リンク限定公開の項目がプールに流れると「URL を知っている人だけ」という約束が破れる
 * - **人数を応答に入れていないこと。** 人数は非公開リストも数えているので、
 *   出すと**何人が非公開でその本文を持っているかを問い合わせられる**
 * - **並び順が毎回同じこと。** 同数のときに揺れると画面が意味もなく並び替わる
 *
 * ⚠️ **`/api/discover` は `pool` を読むだけ**（#254）。プールを作るのはバッチなので、
 * **読む前に1回まわす**（`readPool` が `runBatch` を呼ぶ）。
 * 作り直しそのもののテストは `pool-build.test.ts`。
 */

const discover = (query = '', headers?: Headers) =>
  exports.default.fetch(
    new Request(
      `${testBaseUrl()}/api/discover${query}`,
      headers === undefined ? undefined : { headers: Object.fromEntries(headers) },
    ),
  )

/** バッチを1回まわしてから読む。**プールが古いままの状態を見たいときは `discover` を直接使う。** */
async function readPool(query = '', headers?: Headers) {
  await runBatch()

  return await read(query, headers)
}

/** 作り直さずに読む。 */
async function read(query = '', headers?: Headers) {
  const res = await discover(query, headers)
  const body = await res.json<{
    items: { text: string; adopted: boolean }[]
    hasNext: boolean
    genres: { slug: string; label: string }[]
  }>()

  return { status: res.status, ...body }
}

const texts = (rows: { text: string }[]) => rows.map((row) => row.text)

describe('GET /api/discover', () => {
  it('未ログインでも読める（書き始める前の人が対象）', async () => {
    await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })

    const pool = await readPool()

    expect(pool.status).toBe(200)
    expect(texts(pool.items)).toEqual(['南極に行く'])
  })

  it('1件も公開リストが無くても落ちない', async () => {
    expect((await readPool()).items).toEqual([])
  })

  describe('出してよい本文', () => {
    it('🔴 リンク限定公開のリストにしか無い本文は出ない', async () => {
      // ここが漏れると「URL を知っている人だけ」という約束が破れる
      await makeList({ id: 'u1', visibility: 'unlisted', texts: ['リンク限定の項目'] })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 非公開リストにしか無い本文は出ない', async () => {
      await makeList({ id: 's1', visibility: 'private', texts: ['非公開の項目'] })

      expect((await readPool()).items).toEqual([])
    })

    it('🔴 全公開を解除すると、次のバッチで本文がプールから消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      expect(texts((await readPool()).items)).toEqual(['南極に行く'])

      await testDb().update(lists).set({ visibility: 'private' })

      expect((await readPool()).items).toEqual([])
    })

    it('⚠️ 次のバッチまでは残る（プールはリアルタイムではない）', async () => {
      // 消えるのが遅れても漏洩にならない、というのが #253 の判定を前提にした設計。
      // 「即座に消える」と誤解して他の判断を組み立てないよう、ここに書いておく
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await readPool()

      await testDb().update(lists).set({ visibility: 'private' })

      const stale = await discover()
      expect(texts((await stale.json<{ items: { text: string }[] }>()).items)).toEqual([
        '南極に行く',
      ])
    })

    it('🔴 本文を書き換えると、古い本文がプールから消える', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['書き換える前'] })

      await testDb().update(items).set({ text: '書き換えた後' })

      expect(texts((await readPool()).items)).toEqual(['書き換えた後'])
    })

    it('🔴 判定で落ちた本文は出ない（#253）', async () => {
      await makeList({
        id: 'p1',
        visibility: 'public',
        texts: ['田中太郎に告白する', '南極に行く'],
      })
      await runBatch({ 田中太郎に告白する: { verdict: 'ng' } })

      const res = await discover()
      const body = await res.json<{ items: { text: string }[] }>()

      expect(texts(body.items)).toEqual(['南極に行く'])
    })

    it('🔴 まだ判定していない本文は出ない（判定を待つ）', async () => {
      // 判定は1日 360 件しか進まないので、追いつくまでは出ないのが正しい。
      // ここを「未判定は通す」にすると、個人名が判定前に外へ出る
      await makeList({ id: 'p1', visibility: 'public', texts: ['まだ判定していない'] })
      // 判定を作らずにプールだけ作り直す
      await rebuildPool(testDb())

      const res = await discover()

      expect(res.status).toBe(200)
      expect((await res.json<{ items: unknown[] }>()).items).toEqual([])
    })

    it('他の人が全公開で書いていれば残る', async () => {
      // 「そのテキストを持つ全公開リストが無くなったら消える」の裏側
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['南極に行く'] })

      await testDb().update(lists).set({ visibility: 'private' }).where(eq(lists.id, 'p1'))

      expect(texts((await readPool()).items)).toEqual(['南極に行く'])
    })
  })

  describe('返す内容', () => {
    it('🔴 本文と「もう持っているか」だけを返す（作者も完了状態も返さない）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      // 粒度も一緒に入れる（#279。DB が組み合わせを縛っている）
      await testDb().update(items).set({ completedAt: new Date(), completedPrecision: 'day' })

      const [row] = (await readPool()).items

      expect(row).toEqual({ text: '南極に行く', adopted: false })
    })

    it('🔴 人数を返さない（非公開リストの中身が集計から探れないように）', async () => {
      // 出すと「知りたい本文を自分の全公開リストに書く → 人数を読む」で、
      // 何人が非公開でそれを持っているかを問い合わせられる
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await makeList({ id: 's1', visibility: 'private', texts: ['南極に行く'] })

      const [row] = (await readPool()).items

      expect(Object.keys(row ?? {})).toEqual(['text', 'adopted'])
    })

    /**
     * 🔴 **メモは流通させない**（#294、`PRODUCT_SPEC.md` §4.4 の表）。
     * プールは**本文だけ**を集める場で、個人の事情が混ざる場所ではない。
     */
    it('🔴 メモを返さない（プールに流れ込まない）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く'] })
      await testDb()
        .update(items)
        .set({ memo: 'ここは自分だけのメモ' })
        .where(eq(items.listId, 'p1'))

      const body = await readPool()

      expect(JSON.stringify(body)).not.toContain('ここは自分だけのメモ')
      expect(Object.keys(body.items[0] ?? {})).toEqual(['text', 'adopted'])
    })
  })

  describe('本文でまとめる', () => {
    it('同じ本文が2つの公開リストにあっても1行になる', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['南極に行く', 'A'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['南極に行く', 'B'] })

      expect((await readPool()).items.filter((row) => row.text === '南極に行く')).toHaveLength(1)
    })

    it('🔴 表記が違っても代表表現で1行にまとまる（#254）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['富士山登頂'] })
      await runBatch({
        富士山に登りたい: { canonical: '富士山に登る' },
        富士山登頂: { canonical: '富士山に登る' },
      })

      const res = await discover()

      expect(texts((await res.json<{ items: { text: string }[] }>()).items)).toEqual([
        '富士山に登る',
      ])
    })

    it('🔴 まとまった行の人数が両方の書き手を数えている', async () => {
      // 数え損ねると、名寄せするほど順位が下がることになる
      await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい', 'ひとり'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['富士山登頂'] })
      await runBatch({
        富士山に登りたい: { canonical: '富士山に登る' },
        富士山登頂: { canonical: '富士山に登る' },
      })

      const res = await discover()

      // 2人 → 1人 の順。まとめ損ねていれば「ひとり」と並んで本文順になる
      expect(texts((await res.json<{ items: { text: string }[] }>()).items)).toEqual([
        '富士山に登る',
        'ひとり',
      ])
    })
  })

  describe('並び順', () => {
    it('書いている人が多い順', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['ひとり', 'みんな'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['みんな'] })

      expect(texts((await readPool()).items)).toEqual(['みんな', 'ひとり'])
    })

    it('🔴 非公開リストの人も数に入る', async () => {
      // 公開リストが少ないうちは全部1人になり、順序が付かない
      await makeList({ id: 'p1', visibility: 'public', texts: ['ひとり', 'かくれて人気'] })
      await makeList({ id: 's1', visibility: 'private', texts: ['かくれて人気'] })
      await makeList({ id: 'u1', visibility: 'unlisted', texts: ['かくれて人気'] })

      expect(texts((await readPool()).items)).toEqual(['かくれて人気', 'ひとり'])
    })

    it('🔴 同じ人が何度書いても1人（リストを増やして上位に来られない）', async () => {
      const { userId } = await makeList({
        id: 'p1',
        visibility: 'public',
        texts: ['ひとりで連投', 'ふたり'],
      })
      await makeList({ id: 'p2', visibility: 'public', texts: ['ひとりで連投'], userId })
      await makeList({ id: 'p3', visibility: 'public', texts: ['ひとりで連投'], userId })
      await makeList({ id: 'p4', visibility: 'public', texts: ['ふたり'] })

      expect(texts((await readPool()).items)).toEqual(['ふたり', 'ひとりで連投'])
    })

    it('🔴 人数が並んだら本文順（応答が毎回同じ）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['C', 'A', 'B'] })

      expect(texts((await readPool()).items)).toEqual(['A', 'B', 'C'])
      expect(texts((await readPool()).items)).toEqual(['A', 'B', 'C'])
    })
  })

  /**
   * 取り入れ済みを後ろへ回す（#249）。
   *
   * 🔴 見るのは **「他人のリスト ID で並びを変えられないこと」。**
   * ここが通ると、**並びの変化を読むだけで非公開リストの中身を言い当てられる。**
   * 読み取り専用の口から中身が漏れるので、この機能で一番危ないところ。
   */
  describe('取り入れ済みを後ろへ（#249）', () => {
    /** 自分のリストを1つ作る（`texts` は既に持っている本文）。 */
    async function myList(texts: string[]) {
      const me = await signIn(`me-${crypto.randomUUID()}@example.com`)
      const id = `mine-${crypto.randomUUID()}`

      await testDb()
        .insert(lists)
        .values({
          id,
          userId: me.userId,
          title: '自分のリスト',
          visibility: 'private',
          shareId: crypto.randomUUID().replaceAll('-', ''),
        })
      if (texts.length > 0) {
        await testDb()
          .insert(items)
          .values(
            texts.map((text, i) => ({ id: `${id}-${String(i)}`, listId: id, text, position: i })),
          )
      }

      return { ...me, listId: id }
    }

    it('持っている本文が後ろへ回る', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B', 'C'] })
      const me = await myList(['A'])

      const pool = await readPool(`?listId=${me.listId}`, me.headers)

      expect(texts(pool.items)).toEqual(['B', 'C', 'A'])
    })

    it('🔴 ページをまたいで効く（1ページ目に持っている本文が残らない）', async () => {
      // 画面側で並べ替えるだけだと、2ページ目の知らない本文が繰り上がってこない
      const all = Array.from({ length: DISCOVER_PAGE_SIZE + 3 }, (_, i) =>
        String(i).padStart(4, '0'),
      )
      await makeList({ id: 'p1', visibility: 'public', texts: all })
      // 1ページ目に入るはずの本文を3つ持っている
      const me = await myList(['0000', '0001', '0002'])

      const first = await readPool(`?listId=${me.listId}`, me.headers)

      expect(texts(first.items)).not.toContain('0000')
      // 押し出された分だけ、2ページ目にあったはずの本文が繰り上がる
      expect(texts(first.items)).toContain(String(DISCOVER_PAGE_SIZE).padStart(4, '0'))
    })

    it('持っていないものの間では人気順のまま', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['ひとり', 'みんな', '持っている'] })
      await makeList({ id: 'p2', visibility: 'public', texts: ['みんな'] })
      const me = await myList(['持っている'])

      const pool = await readPool(`?listId=${me.listId}`, me.headers)

      expect(texts(pool.items)).toEqual(['みんな', 'ひとり', '持っている'])
    })

    it('持っている本文に印が付く（画面の「リストにあります」）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B'] })
      const me = await myList(['A'])

      const pool = await readPool(`?listId=${me.listId}`, me.headers)

      expect(pool.items).toEqual([
        { text: 'B', adopted: false },
        { text: 'A', adopted: true },
      ])
    })

    it('渡さなければ何も持っていない扱い（未ログイン）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A'] })

      expect((await readPool()).items).toEqual([{ text: 'A', adopted: false }])
    })

    /**
     * 🔴 **束（代表表現）で突き合わせる**（#254）。
     *
     * 完全一致だけで見ると、代表が `富士山に登る`・自分が `富士山登頂` のときに
     * 「持っていない」と出る。取り入れると**同じことが2行**になる。
     */
    describe('別の表記で持っているとき（#254）', () => {
      it('🔴 代表表現が同じなら「持っている」', async () => {
        await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい', 'B'] })
        const me = await myList(['富士山登頂'])
        await runBatch({
          富士山に登りたい: { canonical: '富士山に登る' },
          // 自分の本文にも判定がある状態（自分のリストも全公開にしている、など）
          富士山登頂: { canonical: '富士山に登る' },
        })

        const res = await discover(`?listId=${me.listId}`, me.headers)
        const body = await res.json<{ items: { text: string; adopted: boolean }[] }>()

        expect(body.items).toEqual([
          { text: 'B', adopted: false },
          { text: '富士山に登る', adopted: true },
        ])
      })

      it('⚠️ 判定が無い本文は完全一致でしか拾えない（既知の限界）', async () => {
        // 判定を付けるのは全公開リストの本文だけ（非公開の本文は AI に送らない。#253）。
        // なので**非公開リストにだけある表記ゆれ**は寄せられない。
        // ここを埋めるには非公開の本文を AI に送ることになるので、埋めない
        await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい'] })
        const me = await myList(['富士山登頂'])
        await runBatch({ 富士山に登りたい: { canonical: '富士山に登る' } })

        const res = await discover(`?listId=${me.listId}`, me.headers)
        const body = await res.json<{ items: { text: string; adopted: boolean }[] }>()

        expect(body.items).toEqual([{ text: '富士山に登る', adopted: false }])
      })

      it('代表表現と同じ本文を持っていれば、判定が無くても「持っている」', async () => {
        // 取り入れボタンで入るのは代表表現そのものなので、この経路が一番多い
        await makeList({ id: 'p1', visibility: 'public', texts: ['富士山に登りたい'] })
        const me = await myList(['富士山に登る'])
        await runBatch({ 富士山に登りたい: { canonical: '富士山に登る' } })

        const res = await discover(`?listId=${me.listId}`, me.headers)
        const body = await res.json<{ items: { text: string; adopted: boolean }[] }>()

        expect(body.items).toEqual([{ text: '富士山に登る', adopted: true }])
      })
    })

    describe('断るもの', () => {
      it('🔴 他人のリスト ID では並べ替えられない', async () => {
        // 通ると、並びの変化から非公開リストの中身を読める
        await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B'] })
        const owner = await myList(['A'])
        const stranger = await signIn(`stranger-${crypto.randomUUID()}@example.com`)

        const res = await discover(`?listId=${owner.listId}`, stranger.headers)

        expect(res.status).toBe(404)
      })

      it('🔴 未ログインでは並べ替えられない', async () => {
        await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B'] })
        const owner = await myList(['A'])

        expect((await discover(`?listId=${owner.listId}`)).status).toBe(404)
      })

      it('🔴 存在しない ID と他人の ID で応答が一致する', async () => {
        await makeList({ id: 'p1', visibility: 'public', texts: ['A'] })
        const owner = await myList(['A'])
        const stranger = await signIn(`stranger2-${crypto.randomUUID()}@example.com`)

        const other = await discover(`?listId=${owner.listId}`, stranger.headers)
        const missing = await discover('?listId=no-such-list', stranger.headers)

        expect(other.status).toBe(missing.status)
        expect(await other.text()).toBe(await missing.text())
      })
    })

    it('渡さなければ今まで通り（未ログインでも読める）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B'] })

      expect(texts((await readPool()).items)).toEqual(['A', 'B'])
    })
  })

  /**
   * ジャンル別の入口（#255）。
   *
   * 🔴 見るのは **「絞ったときも、出してはいけない本文が出ないこと」。**
   * 絞り込みを別の経路として足すと、**認可を通していない道が1本増える**のが
   * 一番ありがちな壊れ方。ここは `pool` を読むだけなので構造的に起きないが、
   * その前提が崩れたら気づけるようにしておく。
   */
  describe('ジャンル別（#255）', () => {
    /** ジャンルを散らした全公開リストを1つ作って、バッチをまわす。 */
    async function seedGenres() {
      await makeList({
        id: 'p1',
        visibility: 'public',
        texts: ['オーロラを見る', '南極に行く', 'ラーメンを食べる', '分類できないもの'],
      })
      await runBatch({
        オーロラを見る: { genre: 'travel' },
        南極に行く: { genre: 'travel' },
        ラーメンを食べる: { genre: 'food' },
        分類できないもの: { genre: 'other' },
      })
    }

    it('🔴 指定したジャンル以外が含まれない', async () => {
      await seedGenres()

      expect(texts((await read('?genre=food')).items)).toEqual(['ラーメンを食べる'])
    })

    it('指定しなければ全部出る（その他も含む）', async () => {
      // 入口には出さないが、**プールからは消さない**。眺めている人には見えてよい
      await seedGenres()

      expect(texts((await read()).items)).toHaveLength(4)
    })

    describe('入口に出すジャンル', () => {
      it('1件でもあるジャンルを返す', async () => {
        await seedGenres()

        expect((await read()).genres).toEqual([
          { slug: 'travel', label: '旅行' },
          { slug: 'food', label: '食' },
        ])
      })

      it('🔴 1件も無いジャンルは返さない（押しても空、が起きない）', async () => {
        await seedGenres()

        expect((await read()).genres.map((g) => g.slug)).not.toContain('money')
      })

      it('🔴 その他は入口に出さない（分類の失敗を見せる場所ではない）', async () => {
        await seedGenres()

        expect((await read()).genres.map((g) => g.slug)).not.toContain('other')
      })

      it('🔴 件数を返さない（#241 と同じ理由）', async () => {
        await seedGenres()

        expect(Object.keys((await read()).genres[0] ?? {})).toEqual(['slug', 'label'])
      })

      it('ジャンルを指定しても入口の一覧は変わらない（2ページ目で消えない）', async () => {
        await seedGenres()

        expect((await read('?genre=food')).genres).toEqual((await read()).genres)
      })

      it('プールが空なら1つも返さない', async () => {
        expect((await readPool()).genres).toEqual([])
      })
    })

    describe('出してよい本文', () => {
      it('🔴 リンク限定公開・非公開の本文は、ジャンルを指定しても出ない', async () => {
        await makeList({ id: 'u1', visibility: 'unlisted', texts: ['リンク限定の旅'] })
        await makeList({ id: 's1', visibility: 'private', texts: ['非公開の旅'] })
        await runBatch({
          リンク限定の旅: { genre: 'travel' },
          非公開の旅: { genre: 'travel' },
        })

        expect((await read('?genre=travel')).items).toEqual([])
      })

      it('🔴 判定に落ちた本文は、ジャンルを指定しても出ない', async () => {
        await makeList({ id: 'p1', visibility: 'public', texts: ['田中太郎と旅する'] })
        await runBatch({ 田中太郎と旅する: { verdict: 'ng' } })

        expect((await read('?genre=travel')).items).toEqual([])
      })

      it('🔴 作者・完了状態・人数・元リストへの経路を返さない', async () => {
        await makeList({ id: 'p1', visibility: 'public', texts: ['オーロラを見る'] })
        // 粒度も一緒に入れる（#279。DB が組み合わせを縛っている）
        await testDb().update(items).set({ completedAt: new Date(), completedPrecision: 'day' })
        await runBatch({ オーロラを見る: { genre: 'travel' } })

        expect((await read('?genre=travel')).items).toEqual([
          { text: 'オーロラを見る', adopted: false },
        ])
      })
    })

    it('ページ送りと一緒に使える', async () => {
      const many = Array.from({ length: DISCOVER_PAGE_SIZE + 2 }, (_, i) =>
        String(i).padStart(4, '0'),
      )
      await makeList({ id: 'p1', visibility: 'public', texts: [...many, 'ラーメンを食べる'] })
      await runBatch({ ラーメンを食べる: { genre: 'food' } })

      const second = await read('?genre=travel&page=2')

      // travel は1件も無いので2ページ目は空。**food が混ざらない**のが見たいこと
      expect(second.status).toBe(200)
      expect(second.items).toEqual([])
    })

    describe('断るもの', () => {
      it('🔴 知らないジャンルを断る', async () => {
        expect((await discover('?genre=uchuu')).status).toBe(400)
      })

      it('🔴 その他は指定できない（分類に失敗したものだけの画面を作らない）', async () => {
        expect((await discover('?genre=other')).status).toBe(400)
      })

      it('🔴 日本語のラベルでは絞れない（URL に入れるのはスラッグ）', async () => {
        expect((await discover(`?genre=${encodeURIComponent('旅行')}`)).status).toBe(400)
      })
    })
  })

  describe('ページ送り（#246）', () => {
    /** 1ページに収まらない数を、本文順が分かる形で用意する。 */
    const overflow = () =>
      Array.from({ length: DISCOVER_PAGE_SIZE + 5 }, (_, i) => String(i).padStart(4, '0'))

    it('1ページに出す数に上限がある', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: overflow() })

      expect((await readPool()).items).toHaveLength(DISCOVER_PAGE_SIZE)
    })

    it('🔴 1ページ目で「次がある」と分かる', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: overflow() })

      expect((await readPool()).hasNext).toBe(true)
    })

    it('🔴 収まりきるときは「次がある」と言わない', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A', 'B'] })

      expect((await readPool()).hasNext).toBe(false)
    })

    it('2ページ目に続きが出る（1ページ目と重ならない）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: overflow() })

      const first = await readPool()
      const second = await readPool('?page=2')

      expect(second.items).toHaveLength(5)
      expect(second.hasNext).toBe(false)
      // ちょうど境目で1件飛ぶ／重なる、が一番ありがちな間違い
      expect(texts(second.items)[0]).toBe(String(DISCOVER_PAGE_SIZE).padStart(4, '0'))
      expect(texts(first.items)).not.toContain(texts(second.items)[0])
    })

    it('中身が無いページは空になる（落ちない）', async () => {
      await makeList({ id: 'p1', visibility: 'public', texts: ['A'] })

      expect((await readPool('?page=3')).items).toEqual([])
    })

    describe('断るもの', () => {
      it('🔴 ページ数に上限がある（飛ばす件数を大きくさせない）', async () => {
        // 大きい offset はプール全体を走査したうえで0件を返す
        expect((await discover(`?page=${String(DISCOVER_MAX_PAGE + 1)}`)).status).toBe(400)
      })

      it('0 以下のページを断る', async () => {
        expect((await discover('?page=0')).status).toBe(400)
        expect((await discover('?page=-1')).status).toBe(400)
      })

      it('数でないページを断る', async () => {
        expect((await discover('?page=abc')).status).toBe(400)
      })

      it('小数を断る', async () => {
        expect((await discover('?page=1.5')).status).toBe(400)
      })
    })
  })
})
