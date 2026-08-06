-- 既存のセッションから IP と User-Agent を消す（#58）。
--
-- このアプリには**これらを読む機能が無い**（ログイン履歴も端末一覧も作らない）。
-- 使わない個人情報を持たない。
--
-- 以降の書き込みは `src/auth.ts` の databaseHooks が落とすので、ここは1回きりの掃除。
-- **セッション自体は消さない。** 行を消すとログイン中の利用者が全員ログアウトされる。
--
-- ⚠️ IP の**取得**は止めていない（`disableIpTracking` を使わない）。
-- 止めるとレート制限のキーからも IP が消えるため。理由は `src/auth.ts`。
UPDATE sessions
SET ip_address = NULL,
    user_agent = NULL;
