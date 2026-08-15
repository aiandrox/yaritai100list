import { exports } from 'cloudflare:workers'
import {
  COMPLETED_ON_TIME_ZONE_OFFSET_MS,
  ITEM_MEMO_MAX_LENGTH,
  ITEM_TEXT_MAX_LENGTH,
  ITEMS_PER_LIST_MAX,
  toCompletedOn,
} from '@yaritai100list/shared'
import { asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { items, lists } from '../src/db/schema'
import { signIn, testBaseUrl, testDb } from './helpers'

/**
 * 項目の API のテスト（#89）。
 *
 * 認可は「通らないこと」を書く（`docs/workflow.md` §6）。
 * **自分のリストの URL に他人の項目 ID を混ぜる**経路も見る。
 */

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${testBaseUrl()}${path}`, init))

function json(headers: Headers, method: string, body: unknown) {
  return {
    method,
    headers: { ...Object.fromEntries(headers), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

/** 自分と他人、それぞれのリストを用意する。 */
async function twoUsers() {
  const me = await signIn('me@example.com')
  const other = await signIn('other@example.com')

  await testDb()
    .insert(lists)
    .values([
      { id: 'my-list', userId: me.userId, title: '自分のリスト' },
      { id: 'other-list', userId: other.userId, title: '他人のリスト' },
    ])

  return { me, other }
}

/** 項目を1件足して、その id を返す。 */
async function addItem(headers: Headers, listId: string, text: string): Promise<string> {
  const res = await request(`/api/lists/${listId}/items`, json(headers, 'POST', { text }))
  const { item } = await res.json<{ item: { id: string } }>()

  return item.id
}

/** そのリストの項目を並び順で読む。 */
async function positionsOf(listId: string) {
  const rows = await testDb()
    .select()
    .from(items)
    .where(eq(items.listId, listId))
    .orderBy(asc(items.position))

  return rows.map((row) => `${String(row.position)}:${row.text}`)
}

describe('項目の作成', () => {
  it('末尾に足される。完了日時は入っていない', async () => {
    const { me } = await twoUsers()

    await addItem(me.headers, 'my-list', '南極に行く')
    await addItem(me.headers, 'my-list', 'オーロラを見る')

    expect(await positionsOf('my-list')).toEqual(['0:南極に行く', '1:オーロラを見る'])

    const [first] = await testDb().select().from(items).where(eq(items.position, 0))
    expect(first?.completedAt).toBeNull()
  })

  it('リストの更新日時が新しくなる（最後に更新したリストを出すため）', async () => {
    const { me } = await twoUsers()
    const before = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))

    await addItem(me.headers, 'my-list', '南極に行く')

    const [after] = await testDb().select().from(lists).where(eq(lists.id, 'my-list'))
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before[0]?.updatedAt.getTime() ?? Infinity,
    )
  })

  it('🔴 未ログインでは足せない', async () => {
    await twoUsers()

    const res = await request(
      '/api/lists/my-list/items',
      json(new Headers(), 'POST', { text: 'x' }),
    )

    expect(res.status).toBe(401)
    expect(await testDb().select().from(items)).toEqual([])
  })

  it('🔴 他人のリストには足せない。存在しない ID と応答が一致する', async () => {
    const { me } = await twoUsers()

    const others = await request(
      '/api/lists/other-list/items',
      json(me.headers, 'POST', { text: 'x' }),
    )
    const missing = await request(
      '/api/lists/no-such/items',
      json(me.headers, 'POST', { text: 'x' }),
    )

    expect(others.status).toBe(404)
    expect(await others.text()).toBe(await missing.text())
    expect(await testDb().select().from(items)).toEqual([])
  })

  it('🔴 上限を超えて足せない', async () => {
    const { me } = await twoUsers()

    const rows = Array.from({ length: ITEMS_PER_LIST_MAX }, (_, i) => ({
      id: `item-${String(i)}`,
      listId: 'my-list',
      text: 'x',
      position: i,
    }))

    // ⚠️ 100件を1文で insert すると **D1 が「too many SQL variables」で落ちる**
    // （SQLite のバインド変数の上限。1行4列なので25行ずつに割る）。
    // 取り込み API（#90）でも同じ制限を踏むので、あちらでも分ける必要がある
    for (let i = 0; i < rows.length; i += 20) {
      await testDb()
        .insert(items)
        .values(rows.slice(i, i + 20))
    }

    const res = await request(
      '/api/lists/my-list/items',
      json(me.headers, 'POST', { text: 'over' }),
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Item Limit Reached' })
    expect(await testDb().select().from(items)).toHaveLength(ITEMS_PER_LIST_MAX)
  })

  it('上限を超える本文は拒否する', async () => {
    const { me } = await twoUsers()

    const res = await request(
      '/api/lists/my-list/items',
      json(me.headers, 'POST', { text: 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1) }),
    )

    expect(res.status).toBe(400)
    expect(await testDb().select().from(items)).toEqual([])
  })

  it('🔴 並び順を指定して割り込めない', async () => {
    const { me } = await twoUsers()

    const res = await request(
      '/api/lists/my-list/items',
      json(me.headers, 'POST', { text: 'x', position: 0 }),
    )

    expect(res.status).toBe(400)
  })
})

describe('項目の変更', () => {
  it('本文を変えられる', async () => {
    const { me } = await twoUsers()
    const id = await addItem(me.headers, 'my-list', '南極に行く')

    const res = await request(
      `/api/lists/my-list/items/${id}`,
      json(me.headers, 'PATCH', { text: '北極に行く' }),
    )

    expect(res.status).toBe(200)

    const [row] = await testDb().select().from(items).where(eq(items.id, id))
    expect(row?.text).toBe('北極に行く')
  })

  /** メモ（#294）。**理由・補足・叶えたときのこと。** */
  describe('メモ', () => {
    const patchMemo = (headers: Headers, id: string, memo: unknown) =>
      request(`/api/lists/my-list/items/${id}`, json(headers, 'PATCH', { memo }))

    const memoOf = async (id: string) => {
      const [row] = await testDb().select().from(items).where(eq(items.id, id))

      return row?.memo
    }

    it('書ける・読み戻せる', async () => {
      const { me } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '富士山に登る')

      expect((await patchMemo(me.headers, id, '大学の頃から登りたかった')).status).toBe(200)
      expect(await memoOf(id)).toBe('大学の頃から登りたかった')
    })

    it('本文と一緒に送れる（別の操作にしない）', async () => {
      const { me } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '富士山に登る')

      const res = await request(
        `/api/lists/my-list/items/${id}`,
        json(me.headers, 'PATCH', { text: '富士山に登頂する', memo: 'ご来光が見たい' }),
      )

      expect(res.status).toBe(200)

      const [row] = await testDb().select().from(items).where(eq(items.id, id))
      expect(row?.text).toBe('富士山に登頂する')
      expect(row?.memo).toBe('ご来光が見たい')
    })

    it('null で消せる', async () => {
      const { me } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '富士山に登る')
      await patchMemo(me.headers, id, 'あとで消す')

      expect((await patchMemo(me.headers, id, null)).status).toBe(200)
      expect(await memoOf(id)).toBeNull()
    })

    it('🔴 空文字は null に寄せる（「書いていない」の表し方を1つにする）', async () => {
      const { me } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '富士山に登る')
      await patchMemo(me.headers, id, 'あとで消す')

      expect((await patchMemo(me.headers, id, '   ')).status).toBe(200)
      expect(await memoOf(id)).toBeNull()
    })

    it('🔴 上限を超えたら断る', async () => {
      const { me } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '富士山に登る')

      expect((await patchMemo(me.headers, id, 'あ'.repeat(ITEM_MEMO_MAX_LENGTH))).status).toBe(200)
      expect((await patchMemo(me.headers, id, 'あ'.repeat(ITEM_MEMO_MAX_LENGTH + 1))).status).toBe(
        400,
      )
    })

    it('🔴 他人の項目のメモは書き換えられない', async () => {
      const { me, other } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '富士山に登る')

      expect((await patchMemo(other.headers, id, '書き換え')).status).toBe(404)
      expect(await memoOf(id)).toBeNull()
    })
  })

  /** 共有で見せない設定（#237）。 */
  describe('共有で見せない設定', () => {
    it('隠せる・戻せる', async () => {
      const { me } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '転職する')

      const hidden = await request(
        `/api/lists/my-list/items/${id}`,
        json(me.headers, 'PATCH', { hiddenInShare: true }),
      )
      expect(hidden.status).toBe(200)

      const [row] = await testDb().select().from(items).where(eq(items.id, id))
      expect(row?.hiddenInShare).toBe(true)

      await request(
        `/api/lists/my-list/items/${id}`,
        json(me.headers, 'PATCH', { hiddenInShare: false }),
      )
      const [back] = await testDb().select().from(items).where(eq(items.id, id))
      expect(back?.hiddenInShare).toBe(false)
    })

    it('🔴 他人の項目は隠せない', async () => {
      const { me, other } = await twoUsers()
      const theirs = await addItem(other.headers, 'other-list', '他人の項目')

      const res = await request(
        `/api/lists/other-list/items/${theirs}`,
        json(me.headers, 'PATCH', { hiddenInShare: true }),
      )

      expect(res.status).toBe(404)

      const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
      expect(row?.hiddenInShare).toBe(false)
    })

    it('🔴 自分のリストの URL に他人の項目 ID を混ぜても隠せない', async () => {
      const { me, other } = await twoUsers()
      const theirs = await addItem(other.headers, 'other-list', '他人の項目')

      const res = await request(
        `/api/lists/my-list/items/${theirs}`,
        json(me.headers, 'PATCH', { hiddenInShare: true }),
      )

      expect(res.status).toBe(404)

      const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
      expect(row?.hiddenInShare).toBe(false)
    })
  })

  /**
   * 完了そのもの。
   *
   * 🔴 **完了日時はサーバーが決める**（2026-08-15、#298）。付くのは**その日・粒度 `day`**。
   * #279 で一度「日付なし」を既定にしたが、**ふつうの完了で毎回日付を入れる手数が多く、
   * 戻した**（覚えていない場合は完了の設定で年を空にする）。
   */
  it('🔴 完了にすると、その日の日時と粒度 day が入る', async () => {
    const { me } = await twoUsers()
    const id = await addItem(me.headers, 'my-list', '南極に行く')
    const before = Date.now()

    await request(`/api/lists/my-list/items/${id}`, json(me.headers, 'PATCH', { completed: true }))
    const [done] = await testDb().select().from(items).where(eq(items.id, id))
    expect(done?.completedPrecision).toBe('day')
    expect(done?.completedAt?.getTime()).toBeGreaterThanOrEqual(before)
    expect(done?.completedAt?.getTime()).toBeLessThanOrEqual(Date.now())

    await request(`/api/lists/my-list/items/${id}`, json(me.headers, 'PATCH', { completed: false }))
    const [undone] = await testDb().select().from(items).where(eq(items.id, id))
    expect(undone?.completedPrecision).toBeNull()
    // 🔴 **取り消したら日時も消える**（粒度なしに日時が残る行は DB が拒否する）
    expect(undone?.completedAt).toBeNull()
  })

  /**
   * 完了日を入れる・直す（#207 / #279）。
   *
   * 🔴 境目は「**完了にする**」と「**いつ叶えたか**」の2段。
   * 完了していない項目に日付だけを入れさせない（粒度の付かない行を作らせない）。
   *
   * 送るのは `completedOn`。**形が粒度を表す**（`2026` / `2026-08` / `2026-08-14`）。
   */
  describe('完了日の直し', () => {
    /** 完了済み（その日・粒度 `day`）の項目を1つ作って ID を返す。 */
    async function completedItem(headers: Headers): Promise<string> {
      const id = await addItem(headers, 'my-list', '南極に行く')
      await request(`/api/lists/my-list/items/${id}`, json(headers, 'PATCH', { completed: true }))

      return id
    }

    const patchCompletedOn = (headers: Headers, id: string, completedOn: unknown) =>
      request(`/api/lists/my-list/items/${id}`, json(headers, 'PATCH', { completedOn }))

    const rowOf = async (id: string) => {
      const [row] = await testDb().select().from(items).where(eq(items.id, id))

      return row
    }

    it('日まで入れられる。粒度は day', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)

      const res = await patchCompletedOn(me.headers, id, '2020-05-03')

      expect(res.status).toBe(200)

      const row = await rowOf(id)
      expect(row?.completedPrecision).toBe('day')
      // 🔴 **日本時間の 00:00 で持つ**（#279）。共有ページ（Asia/Tokyo）で同じ日に出る
      expect(row?.completedAt?.toISOString()).toBe('2020-05-02T15:00:00.000Z')
    })

    it('年だけ入れられる。その年の頭（日本時間）を持つ', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)

      expect((await patchCompletedOn(me.headers, id, '2020')).status).toBe(200)

      const row = await rowOf(id)
      expect(row?.completedPrecision).toBe('year')
      expect(row?.completedAt?.toISOString()).toBe('2019-12-31T15:00:00.000Z')
    })

    it('年月だけ入れられる。その月の頭（日本時間）を持つ', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)

      expect((await patchCompletedOn(me.headers, id, '2020-05')).status).toBe(200)

      const row = await rowOf(id)
      expect(row?.completedPrecision).toBe('month')
      expect(row?.completedAt?.toISOString()).toBe('2020-04-30T15:00:00.000Z')
    })

    it('🔴 null で日付なしに戻せる。完了は取り消さない', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)
      await patchCompletedOn(me.headers, id, '2020-05-03')

      expect((await patchCompletedOn(me.headers, id, null)).status).toBe(200)

      const row = await rowOf(id)
      expect(row?.completedPrecision).toBe('unknown')
      expect(row?.completedAt).toBeNull()
    })

    /**
     * 日本時間の暦日（`YYYY-MM-DD`）。**サーバーと同じ変換**（#300）。
     *
     * `toCompletedOn` は日付ありの粒度なら必ず返すが、型は `null` を含む。
     * **黙って別の値に倒さない**（倒すと、間違った日付で通ったのか分からなくなる）。
     */
    const jstDay = (at: Date): string => {
      const value = toCompletedOn(at, 'day')
      if (value === null) throw new Error('日付を作れなかった')

      return value
    }

    it('🔴 未来は拒否される（来年・来月・明日）', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)

      /*
       * 🔴 **日付は日本時間で組み立てる**（#300）。
       * サーバーは完了日を**日本時間の暦日**として読む（#279）ので、
       * UTC で「明日」を作ると、**UTC 15:00〜24:00（日本時間の 0〜9時）の間だけ
       * それが JST では過去になり、正しく通ってしまう。**
       *
       * 判定の基準を2箇所に書かないよう、**サーバーと同じ `toCompletedOn`** を使う。
       * ⚠️ `now + 24h` の JST 日付は、必ず**その日の頭が未来**になる（境目も安全）。
       */
      const now = new Date()
      const jstNow = new Date(now.getTime() + COMPLETED_ON_TIME_ZONE_OFFSET_MS)
      const nextYear = String(jstNow.getUTCFullYear() + 1)
      const nextDay = jstDay(new Date(now.getTime() + 24 * 60 * 60 * 1000))

      for (const value of [nextYear, `${nextYear}-01`, nextDay]) {
        expect((await patchCompletedOn(me.headers, id, value)).status).toBe(400)
      }

      // 弾かれたので、✓ を押したときの日付（今日・粒度 day）のまま
      const row = await rowOf(id)
      expect(row?.completedPrecision).toBe('day')
      expect(jstDay(row?.completedAt ?? new Date(0))).toBe(jstDay(now))
    })

    it('今年・今月・今日は通る（期間の頭で判定するため）', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)

      // 日本時間の今日から組み立てる（上の「未来は拒否される」と同じ理由。#300）
      const todayJst = jstDay(new Date())

      expect((await patchCompletedOn(me.headers, id, todayJst.slice(0, 4))).status).toBe(200)
      expect((await patchCompletedOn(me.headers, id, todayJst.slice(0, 7))).status).toBe(200)
      expect((await patchCompletedOn(me.headers, id, todayJst)).status).toBe(200)
    })

    it('🔴 完了していない項目には入れられない', async () => {
      const { me } = await twoUsers()
      const id = await addItem(me.headers, 'my-list', '南極に行く')

      const res = await patchCompletedOn(me.headers, id, '2020-05-03')

      expect(res.status).toBe(409)

      const row = await rowOf(id)
      expect(row?.completedAt).toBeNull()
      expect(row?.completedPrecision).toBeNull()
    })

    it('🔴 completed と同時には送れない', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)

      const res = await request(
        `/api/lists/my-list/items/${id}`,
        json(me.headers, 'PATCH', { completed: false, completedOn: '2020-05-03' }),
      )

      expect(res.status).toBe(400)
    })

    it('🔴 読めない値は拒否される', async () => {
      const { me } = await twoUsers()
      const id = await completedItem(me.headers)

      for (const bad of [
        4_102_444_800_000, // 旧実装は epoch ms だった
        '2020-05-03T04:05:06.000Z', // #279 より前の形（日時）
        '2026-02-30', // 存在しない日
        '2026-13-01',
        '1899', // 1900年より前
        '20-05-03',
        'あした',
        '',
      ]) {
        expect((await patchCompletedOn(me.headers, id, bad)).status).toBe(400)
      }

      // 何も変わっていない（✓ を押したときの粒度のまま）
      expect((await rowOf(id))?.completedPrecision).toBe('day')
    })

    it('🔴 他人の項目の完了日は直せない', async () => {
      const { me, other } = await twoUsers()
      const id = await completedItem(me.headers)

      const res = await patchCompletedOn(other.headers, id, '2020-05-03')

      expect(res.status).toBe(404)
      expect((await rowOf(id))?.completedAt?.getFullYear()).not.toBe(2020)
    })
  })

  it('🔴 完了しても並び順が変わらない', async () => {
    const { me } = await twoUsers()
    await addItem(me.headers, 'my-list', '1つ目')
    const second = await addItem(me.headers, 'my-list', '2つ目')
    await addItem(me.headers, 'my-list', '3つ目')

    await request(
      `/api/lists/my-list/items/${second}`,
      json(me.headers, 'PATCH', { completed: true }),
    )

    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:2つ目', '2:3つ目'])
  })

  it('空の本文は拒否する（黙って何もしない応答を返さない）', async () => {
    const { me } = await twoUsers()
    const id = await addItem(me.headers, 'my-list', '南極に行く')

    const res = await request(`/api/lists/my-list/items/${id}`, json(me.headers, 'PATCH', {}))

    expect(res.status).toBe(400)
  })

  it('🔴 他人のリストの項目は変えられない', async () => {
    const { me, other } = await twoUsers()
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request(
      `/api/lists/other-list/items/${theirs}`,
      json(me.headers, 'PATCH', { text: '乗っ取り' }),
    )

    expect(res.status).toBe(404)

    const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
    expect(row?.text).toBe('他人の項目')
  })

  it('🔴 自分のリストの URL に他人の項目 ID を混ぜても変えられない', async () => {
    const { me, other } = await twoUsers()
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    // リストの所有者チェックは通るので、項目とリストの紐付けを見ないと通ってしまう
    const res = await request(
      `/api/lists/my-list/items/${theirs}`,
      json(me.headers, 'PATCH', { text: '乗っ取り' }),
    )

    expect(res.status).toBe(404)

    const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
    expect(row?.text).toBe('他人の項目')
  })
})

describe('項目の削除', () => {
  it('🔴 消すと後ろの並び順が詰まる', async () => {
    const { me } = await twoUsers()
    await addItem(me.headers, 'my-list', '1つ目')
    const second = await addItem(me.headers, 'my-list', '2つ目')
    await addItem(me.headers, 'my-list', '3つ目')

    await request(`/api/lists/my-list/items/${second}`, {
      method: 'DELETE',
      headers: me.headers,
    })

    // 穴が空くと「0から始まる詰まった連番」という前提が崩れる（TECH_STACK.md §7）
    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:3つ目'])
  })

  it('🔴 他人の項目は消せない', async () => {
    const { me, other } = await twoUsers()
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request(`/api/lists/my-list/items/${theirs}`, {
      method: 'DELETE',
      headers: me.headers,
    })

    expect(res.status).toBe(404)
    expect(await testDb().select().from(items).where(eq(items.id, theirs))).toHaveLength(1)
  })
})

describe('並び替え', () => {
  it('送った順に並び直る', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    const b = await addItem(me.headers, 'my-list', '2つ目')
    const c = await addItem(me.headers, 'my-list', '3つ目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [c, a, b] }),
    )

    expect(res.status).toBe(200)
    expect(await positionsOf('my-list')).toEqual(['0:3つ目', '1:1つ目', '2:2つ目'])
  })

  it('🔴 項目が欠けている並びは拒否する', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    await addItem(me.headers, 'my-list', '2つ目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [a] }),
    )

    expect(res.status).toBe(409)
    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:2つ目'])
  })

  it('🔴 他人の項目 ID を混ぜて引き込めない', async () => {
    const { me, other } = await twoUsers()
    const mine = await addItem(me.headers, 'my-list', '自分の項目')
    const theirs = await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [theirs, mine] }),
    )

    expect(res.status).toBe(409)

    const [row] = await testDb().select().from(items).where(eq(items.id, theirs))
    expect(row?.listId).toBe('other-list')
  })

  it('🔴 同じ ID を並べて数を合わせられない', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    await addItem(me.headers, 'my-list', '2つ目')

    const res = await request(
      '/api/lists/my-list/items/order',
      json(me.headers, 'PUT', { itemIds: [a, a] }),
    )

    expect(res.status).toBe(409)
    expect(await positionsOf('my-list')).toEqual(['0:1つ目', '1:2つ目'])
  })
})

describe('書き込みを減らす（#142）', () => {
  it('位置が変わっていない項目は書き直さない', async () => {
    // 隣と入れ替えるだけで100行書くと、D1 の 10万行/日 をすぐ使う（TECH_STACK.md §13）
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    const b = await addItem(me.headers, 'my-list', '2つ目')
    const c = await addItem(me.headers, 'my-list', '3つ目')

    const before = await testDb().select().from(items).where(eq(items.id, c))

    // 先頭2つだけ入れ替える。3つ目は位置が変わらない
    await request('/api/lists/my-list/items/order', json(me.headers, 'PUT', { itemIds: [b, a, c] }))

    const [after] = await testDb().select().from(items).where(eq(items.id, c))

    expect(await positionsOf('my-list')).toEqual(['0:2つ目', '1:1つ目', '2:3つ目'])
    // 触っていない項目は updated_at も動かない
    expect(after?.updatedAt.getTime()).toBe(before[0]?.updatedAt.getTime())
  })
})

describe('リストの取得', () => {
  it('リストと項目を並び順で返す', async () => {
    const { me } = await twoUsers()
    const a = await addItem(me.headers, 'my-list', '1つ目')
    const b = await addItem(me.headers, 'my-list', '2つ目')
    await request('/api/lists/my-list/items/order', json(me.headers, 'PUT', { itemIds: [b, a] }))

    const res = await request('/api/lists/my-list', { headers: me.headers })
    const body = await res.json<{ list: { id: string }; items: { id: string }[] }>()

    expect(body.list.id).toBe('my-list')
    expect(body.items.map((item) => item.id)).toEqual([b, a])
  })

  it('🔴 他人のリストの項目は読めない', async () => {
    const { me, other } = await twoUsers()
    await addItem(other.headers, 'other-list', '他人の項目')

    const res = await request('/api/lists/other-list', { headers: me.headers })

    expect(res.status).toBe(404)
  })

  it('リストを消すと項目も消える', async () => {
    const { me } = await twoUsers()
    await addItem(me.headers, 'my-list', '1つ目')

    await request('/api/lists/my-list', { method: 'DELETE', headers: me.headers })

    expect(await testDb().select().from(items)).toEqual([])
  })
})
