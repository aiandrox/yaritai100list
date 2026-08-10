import {
  FALLBACK_GENRE,
  GENRES,
  ITEM_TEXT_MAX_LENGTH,
  normalizePoolText,
  poolJudgementPrompt,
  toPoolJudgement,
} from '@yaritai100list/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import { items, lists, wishTexts } from '../src/db/schema'
import { judgeUnjudged, poolJudgeInput, selectUnjudged } from '../src/pool-judge'
import { createTestUser, testDb } from './helpers'

/**
 * 取り入れ面に出してよいかの判定（#253 / 親 #252）。
 *
 * 🔴 見るのは **「迷ったら出さないに倒れること」。**
 * Cloudflare 自身が「**スキーマ通りに返る保証はない**」と書いているので、
 * **読めない応答が来たときにどうなるか**が、この機能の本体と言っていい。
 *
 * ⚠️ **Workers AI のバインディングはテスト環境に無い。**
 * だから `judgeUnjudged` は AI を引数で受け取る形にしてある（差し替えられる）。
 */

describe('normalizePoolText', () => {
  it('全角英数を半角にする', () => {
    expect(normalizePoolText('ＹｏｕＴｕｂｅを始める')).toBe('YouTubeを始める')
    expect(normalizePoolText('１００冊読む')).toBe('100冊読む')
  })

  it('半角カナを全角にする', () => {
    expect(normalizePoolText('ｵｰﾛﾗを見る')).toBe('オーロラを見る')
  })

  it('前後の空白と連続する空白を落とす', () => {
    expect(normalizePoolText('  富士山に  登る 　')).toBe('富士山に 登る')
  })

  it('🔴 小文字にはしない（元の本文をそのまま出すことがある）', () => {
    expect(normalizePoolText('YouTubeを始める')).toBe('YouTubeを始める')
  })

  it('何度掛けても結果が変わらない', () => {
    const once = normalizePoolText('ＹｏｕＴｕｂｅ　を  始める')

    expect(normalizePoolText(once)).toBe(once)
  })
})

describe('toPoolJudgement', () => {
  const ok = { publishable: true, canonical: '富士山に登る', genre: 'travel' }

  it('通れば代表表現とジャンルが残る', () => {
    expect(toPoolJudgement(ok, '富士山登頂')).toEqual({
      publishable: true,
      canonical: '富士山に登る',
      genre: 'travel',
    })
  })

  describe('🔴 迷ったら出さない', () => {
    it('publishable が false なら出さない', () => {
      expect(toPoolJudgement({ ...ok, publishable: false }, '富士山登頂')).toEqual({
        publishable: false,
      })
    })

    it.each([
      ['読めない応答', undefined],
      ['null', null],
      ['文字列', 'はい'],
      ['鍵が足りない', { publishable: true }],
      ['型が違う', { publishable: 'true', canonical: 'x', genre: 'travel' }],
    ])('%s なら出さない', (_name, raw) => {
      expect(toPoolJudgement(raw, '富士山登頂')).toEqual({ publishable: false })
    })
  })

  describe('代表表現', () => {
    it('🔴 上限を超えたら、実際に書かれた表記に落ちる', () => {
      // 取り入れると人のリストに入るので、itemTextSchema を通らないものは使えない
      const tooLong = 'あ'.repeat(ITEM_TEXT_MAX_LENGTH + 1)

      expect(toPoolJudgement({ ...ok, canonical: tooLong }, '富士山登頂')).toEqual({
        publishable: true,
        canonical: '富士山登頂',
        genre: 'travel',
      })
    })

    it('🔴 空なら、実際に書かれた表記に落ちる', () => {
      expect(toPoolJudgement({ ...ok, canonical: '   ' }, '富士山登頂')).toMatchObject({
        canonical: '富士山登頂',
      })
    })

    it('代表表現も正規化する', () => {
      expect(toPoolJudgement({ ...ok, canonical: '  ＹｏｕＴｕｂｅを始める ' }, 'x')).toMatchObject(
        { canonical: 'YouTubeを始める' },
      )
    })
  })

  describe('ジャンル', () => {
    it('知らないジャンルは その他 になる', () => {
      expect(toPoolJudgement({ ...ok, genre: '宇宙' }, 'x')).toMatchObject({
        genre: FALLBACK_GENRE,
      })
    })

    it('決めた一覧のスラッグは通る', () => {
      for (const genre of GENRES) {
        expect(toPoolJudgement({ ...ok, genre: genre.slug }, 'x')).toMatchObject({
          genre: genre.slug,
        })
      }
    })
  })
})

describe('poolJudgementPrompt / poolJudgeInput', () => {
  it('ジャンルの一覧が指示に入っている（画面と別に書かない）', () => {
    const prompt = poolJudgementPrompt()

    for (const genre of GENRES) expect(prompt).toContain(genre.slug)
  })

  it('🔴 文字数の上限を指示に埋め込まない（shared の定数から出す）', () => {
    expect(poolJudgementPrompt()).toContain(String(ITEM_TEXT_MAX_LENGTH))
  })

  it('判定する本文を user のメッセージに載せる', () => {
    const input = poolJudgeInput('富士山登頂')

    expect(input.messages[1]).toEqual({ role: 'user', content: '富士山登頂' })
    expect(input.response_format.type).toBe('json_schema')
  })
})

/** 全公開のリストを1つ作って本文を入れる。 */
async function seedPublic(
  id: string,
  texts: string[],
  visibility: 'private' | 'unlisted' | 'public' = 'public',
) {
  const db = testDb()
  const userId = await createTestUser(`${id}@example.com`)

  await db.insert(lists).values({
    id,
    userId,
    title: 'x',
    visibility,
    shareId: crypto.randomUUID().replaceAll('-', ''),
  })
  await db
    .insert(items)
    .values(texts.map((text, i) => ({ id: `${id}-${String(i)}`, listId: id, text, position: i })))
}

describe('selectUnjudged', () => {
  it('全公開リストの本文を、正規化した形で返す', async () => {
    await seedPublic('p1', ['ＹｏｕＴｕｂｅを始める'])

    expect(await selectUnjudged(testDb(), 10)).toEqual(['YouTubeを始める'])
  })

  it('🔴 リンク限定公開・非公開の本文は AI に送らない', async () => {
    // 出す予定の無い本文を外に出すことになる
    await seedPublic('u1', ['リンク限定の本文'], 'unlisted')
    await seedPublic('s1', ['非公開の本文'], 'private')

    expect(await selectUnjudged(testDb(), 10)).toEqual([])
  })

  it('🔴 表記だけ違うものを2回送らない', async () => {
    await seedPublic('p1', ['ＹｏｕＴｕｂｅを始める'])
    await seedPublic('p2', ['YouTubeを始める'])

    expect(await selectUnjudged(testDb(), 10)).toEqual(['YouTubeを始める'])
  })

  it('判定済みの本文は返さない', async () => {
    await seedPublic('p1', ['富士山に登る', 'オーロラを見る'])
    await testDb().insert(wishTexts).values({
      normalized: '富士山に登る',
      verdict: 'ok',
      canonical: '富士山に登る',
      genre: 'travel',
    })

    expect(await selectUnjudged(testDb(), 10)).toEqual(['オーロラを見る'])
  })

  it('件数の上限が効く', async () => {
    await seedPublic('p1', ['A', 'B', 'C'])

    expect(await selectUnjudged(testDb(), 2)).toHaveLength(2)
  })
})

describe('judgeUnjudged', () => {
  const answer = (value: unknown) => ({ run: vi.fn().mockResolvedValue({ response: value }) })

  it('判定を貯める', async () => {
    await seedPublic('p1', ['富士山登頂'])
    const ai = answer({ publishable: true, canonical: '富士山に登る', genre: 'travel' })

    const result = await judgeUnjudged(testDb(), ai)

    expect(result).toEqual({ judged: 1, failed: 0 })

    const [row] = await testDb().select().from(wishTexts)
    expect(row).toMatchObject({
      normalized: '富士山登頂',
      verdict: 'ok',
      canonical: '富士山に登る',
      genre: 'travel',
    })
  })

  it('JSON の文字列で返ってきても読める', async () => {
    await seedPublic('p1', ['富士山登頂'])
    const ai = answer(
      JSON.stringify({ publishable: true, canonical: '富士山に登る', genre: 'travel' }),
    )

    await judgeUnjudged(testDb(), ai)

    expect((await testDb().select().from(wishTexts))[0]?.canonical).toBe('富士山に登る')
  })

  it('🔴 出さないと判断したら、代表表現もジャンルも持たない', async () => {
    await seedPublic('p1', ['田中太郎に告白する'])
    const ai = answer({ publishable: false, canonical: '', genre: 'other' })

    await judgeUnjudged(testDb(), ai)

    const [row] = await testDb().select().from(wishTexts)
    expect(row).toMatchObject({ verdict: 'ng', canonical: null, genre: null })
  })

  it('🔴 読めない応答は「出さない」になる', async () => {
    await seedPublic('p1', ['なにか'])
    const ai = answer('これは JSON ではありません')

    await judgeUnjudged(testDb(), ai)

    expect((await testDb().select().from(wishTexts))[0]?.verdict).toBe('ng')
  })

  it('🔴 AI が落ちたら保存しない（次のバッチで挑み直す）', async () => {
    // 「出さない」として保存すると、一時的な障害が恒久的な除外になる
    await seedPublic('p1', ['なにか'])
    const ai = { run: vi.fn().mockRejectedValue(new Error('unavailable')) }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await judgeUnjudged(testDb(), ai)

    expect(result).toEqual({ judged: 0, failed: 1 })
    expect(await testDb().select().from(wishTexts)).toEqual([])

    logged.mockRestore()
  })

  it('🔴 1件落ちても残りを続ける', async () => {
    await seedPublic('p1', ['A', 'B'])
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({ response: { publishable: true, canonical: 'B', genre: 'other' } })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await judgeUnjudged(testDb(), { run })

    expect(result).toEqual({ judged: 1, failed: 1 })

    logged.mockRestore()
  })

  it('同じ本文に2回 AI を使わない', async () => {
    await seedPublic('p1', ['富士山登頂'])
    const ai = answer({ publishable: true, canonical: '富士山に登る', genre: 'travel' })

    await judgeUnjudged(testDb(), ai)
    await judgeUnjudged(testDb(), ai)

    expect(ai.run).toHaveBeenCalledTimes(1)
  })

  it('1回で処理する件数に上限がある', async () => {
    await seedPublic('p1', ['A', 'B', 'C', 'D'])
    const ai = answer({ publishable: true, canonical: 'x', genre: 'other' })

    const result = await judgeUnjudged(testDb(), ai, 2)

    expect(result.judged).toBe(2)
  })

  it('判定するものが無ければ何もしない', async () => {
    const ai = answer({ publishable: true, canonical: 'x', genre: 'other' })

    expect(await judgeUnjudged(testDb(), ai)).toEqual({ judged: 0, failed: 0 })
    expect(ai.run).not.toHaveBeenCalled()
  })
})

describe('wish_texts', () => {
  it('🔴 項目を消しても判定は残る（また同じことを書く人がいる）', async () => {
    await seedPublic('p1', ['富士山に登る'])
    const ai = {
      run: vi.fn().mockResolvedValue({
        response: { publishable: true, canonical: '富士山に登る', genre: 'travel' },
      }),
    }
    await judgeUnjudged(testDb(), ai)

    await testDb().delete(items).where(eq(items.listId, 'p1'))

    expect(await testDb().select().from(wishTexts)).toHaveLength(1)
  })
})
