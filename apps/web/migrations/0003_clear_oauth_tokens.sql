-- 既存の行から OAuth の資格情報を消す（#58）。
--
-- このアプリは Google を**ログインの手段としてしか使わない。**
-- Google の API を呼ばないので、access_token も id_token も使い道が無い。
-- 使わないものを持ち続ける理由が無いため消す。
--
-- 以降の書き込みは `src/auth.ts` の databaseHooks が落とすので、ここは1回きりの掃除。
-- **列自体は残す。** Better Auth のスキーマ定義に存在するため、
-- 列を消すとアダプタが書き込み時にその列を引けなくなる。
--
-- refresh_token は offline access を要求していないので元から返ってこないが、
-- 要求を増やしたときに黙って保存され始めないよう、ここでも消しておく。
UPDATE accounts
SET access_token = NULL,
    id_token = NULL,
    refresh_token = NULL,
    access_token_expires_at = NULL,
    refresh_token_expires_at = NULL;
