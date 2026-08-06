/**
 * クライアントのロジックのうち、**DOM を触らない部分**。
 *
 * ここだけをテストする（`TECH_STACK.md` §10 の方針。#43 で決定）。
 * テストは workerd の中で走るので、**このファイルに DOM の API を持ち込まないこと。**
 * 持ち込むとテストが落ちる。描画と配線は `*.tsx` 側に置く。
 */

/**
 * ログイン状態。
 *
 * **`error` を `anonymous` に混ぜないこと。** 混ぜると、
 * セッションの取得に失敗しただけなのに「未ログイン」として扱われ、
 * ログイン済みの利用者にログインの導線を出してしまう。逆に `authenticated` に
 * 倒すと、未ログインの利用者からログインの導線が消える。**どちらも詰む。**
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated' }
  | { status: 'error' }

/**
 * `GET /api/auth/get-session` の応答からログイン状態を決める。
 *
 * Better Auth はログイン中なら `{ session, user }` を、未ログインなら `null` を
 * **どちらも 200 で**返す。したがって**状態は本文で見分ける**。
 *
 * 🔴 **HTTP の失敗を「未ログイン」として扱わない。**
 * `null` かどうかだけで判定すると、500 の応答（本文はエラーオブジェクト）が
 * `authenticated` になり、**障害中にログインの導線が消える。**
 * Better Auth 側にも内部エラーを `null` に潰す不具合があり
 * （better-auth#10566。#3 に記録）、区別できるのは HTTP の状態までなので、
 * **せめてそこは落とさない。**
 */
export function toSessionState(response: { ok: boolean; body: unknown }): SessionState {
  if (!response.ok) return { status: 'error' }
  if (response.body === null) return { status: 'anonymous' }

  // 200 なのに想定外の形。ログイン中と決めつけない
  if (typeof response.body !== 'object' || !('user' in response.body)) {
    return { status: 'error' }
  }

  return { status: 'authenticated' }
}
