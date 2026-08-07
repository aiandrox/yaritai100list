-- 1人が持てるリストの数を **DB でも** 止める（#99）。
--
-- アプリ側では `POST /api/lists` と取り込みが条件付き insert で止めているが、
-- 「決めた仕様はできる限り DB の制約にする」という方針（`TECH_STACK.md` §7）と、
-- **アプリコードだけに頼らない**というイシュー #6 の要求に従って、ここでも止める。
--
-- 🔴 **上限の 5 がここに直接書いてある。**
-- 上限の情報源は `packages/shared/src/limits.ts` の `LISTS_PER_USER_MAX` 1箇所、
-- という不変条件（`CLAUDE.md`）との折り合いとして、
-- **両者が一致することをテストで固定してある**（`apps/web/test/lists.test.ts`）。
-- 定数を変えるとテストが落ちるので、マイグレーションの追加を忘れられない。
--
-- 文字数の上限を DB に書かないのとは扱いが違う。あちらは違反しても
-- レイアウトが崩れるだけだが、リストの数は**容量と課金に効く境界**なので、
-- アプリの不具合で青天井に作られる経路を残さない。
--
-- CHECK 制約では書けない（他の行を数える必要がある）ためトリガーにする。
CREATE TRIGGER lists_per_user_limit_on_insert
BEFORE INSERT ON lists
FOR EACH ROW
WHEN (SELECT count(*) FROM lists WHERE user_id = NEW.user_id) >= 5
BEGIN
	SELECT RAISE(ABORT, 'lists per user limit reached');
END;
--> statement-breakpoint
-- 持ち主の付け替えでも越えられないようにする。
-- API は `user_id` を受け取らないが、**経路が1つだけという前提に頼らない。**
CREATE TRIGGER lists_per_user_limit_on_update
BEFORE UPDATE OF user_id ON lists
FOR EACH ROW
WHEN NEW.user_id <> OLD.user_id
  AND (SELECT count(*) FROM lists WHERE user_id = NEW.user_id) >= 5
BEGIN
	SELECT RAISE(ABORT, 'lists per user limit reached');
END;
