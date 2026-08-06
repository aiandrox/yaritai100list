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

/**
 * `POST /api/auth/sign-out` に送る内容。**`App.tsx` とテストで同じものを使う。**
 *
 * 🔴 **`content-type: application/json` と本文 `{}` の両方が要る。**
 * 素の `fetch(url, { method: 'POST' })` は本番で **415** になる（実際に踏んだ）。
 *
 * better-call の本文パーサ（`better-call/dist/utils.mjs`）はこう書かれている:
 *
 * ```js
 * if (!request.body) return                                  // 本文が無ければ素通し
 * if (!normalizedContentType) throw new APIError(415, ...)   // 本文があるのに content-type が無い
 * ```
 *
 * ブラウザは本文の無い POST でも `Content-Length: 0` を送るため、Workers 側からは
 * **空ストリームの「本文あり」**に見えて 415 に落ちる。
 * 一方 `new Request(url, { method: 'POST' })` は `body` が `null` なので素通しし、
 * **テストだけ 200 になる。** テストからこの定義を使うのは、その差を作らないため。
 *
 * `content-type` だけ付けて本文を空にすると、今度は `request.json()` が
 * SyntaxError になり **400** が返る。だから `{}` を送る。
 */
export function signOutRequestInit(): {
  method: string
  headers: Record<string, string>
  body: string
} {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }
}
