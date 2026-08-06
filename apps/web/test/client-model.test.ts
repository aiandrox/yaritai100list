import { describe, expect, it } from 'vitest'

import { toSessionState } from '../src/client/model'

/**
 * クライアント側で**唯一テストする層**（`TECH_STACK.md` §10、#43）。
 *
 * 描画と配線（ボタンに handler が付いているか等）はテストしない。
 * ここで担保するのは「応答からログイン状態をどう決めるか」だけ。
 */
describe('toSessionState', () => {
  it('200 で本文が null なら未ログイン', () => {
    // Better Auth は未ログインでも 200 を返す。**本文で見分ける**
    expect(toSessionState({ ok: true, body: null })).toEqual({ status: 'anonymous' })
  })

  it('200 で user が入っていればログイン中', () => {
    const body = { session: { id: 's1' }, user: { id: 'u1' } }

    expect(toSessionState({ ok: true, body })).toEqual({ status: 'authenticated' })
  })

  it('🔴 HTTP が失敗なら error。未ログインにもログイン中にも倒さない', () => {
    // 500 の本文はエラーオブジェクトなので、`null` かどうかだけで判定すると
    // **ログイン中**になり、障害中にログインの導線が消える
    const body = { code: 'INTERNAL_SERVER_ERROR', message: 'boom' }

    expect(toSessionState({ ok: false, body })).toEqual({ status: 'error' })
  })

  it('200 でも想定外の形なら error', () => {
    // 応答の形が変わったときに、黙ってログイン中として扱わない
    expect(toSessionState({ ok: true, body: {} })).toEqual({ status: 'error' })
    expect(toSessionState({ ok: true, body: 'ok' })).toEqual({ status: 'error' })
    expect(toSessionState({ ok: true, body: undefined })).toEqual({ status: 'error' })
  })
})
