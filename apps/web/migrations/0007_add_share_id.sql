-- 公開用の ID（`share_id`）を足す（#135）。
--
-- 🔴 **手で書いたマイグレーション。drizzle-kit の生成物は使えない。**
-- 生成されたのは次の1文だった:
--   ALTER TABLE `lists` ADD `share_id` text NOT NULL;
-- SQLite は **DEFAULT の無い NOT NULL 列を ADD COLUMN できない**（0002 で踏んだのと同じ）。
--
-- 🔴 **テーブルを作り直す手も使えない。**
-- 本番には既にリストと項目がある（2026-08-08 時点で 2 リスト / 113 項目）。
-- `items` は `lists` を `ON DELETE CASCADE` で参照しているので、
-- **`DROP TABLE lists` は項目を全部消す**（SQLite は DROP の前に暗黙の DELETE を行い、
-- 外部キーの動作が発生する）。0002 のときは 0 行だったので作り直せた。今は違う。
--
-- そこで:
--   1. NULL を許して列を足す
--   2. 既存の行を埋める（**推測不可能な値**。連番にしない。CLAUDE.md の不変条件）
--   3. 一意にする
--   4. **NULL を入れられないようにトリガーで縛る**（列の NOT NULL は後から付けられない）
--
-- `randomblob(16)` は 128 ビット。`newShareId()`（`src/id.ts`）と**同じ形**にしてある。
ALTER TABLE `lists` ADD `share_id` text;--> statement-breakpoint
UPDATE `lists` SET `share_id` = lower(hex(randomblob(16))) WHERE `share_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `lists_share_id_unique` ON `lists` (`share_id`);--> statement-breakpoint
-- 列の宣言としては NULL 可のままなので、**DB 側の縛りはトリガーで作る。**
-- アプリは必ず入れているが、経路が1つだけという前提に頼らない（#99 と同じ考え方）。
CREATE TRIGGER lists_share_id_required_on_insert
BEFORE INSERT ON lists
FOR EACH ROW
WHEN NEW.share_id IS NULL
BEGIN
	SELECT RAISE(ABORT, 'share_id is required');
END;--> statement-breakpoint
CREATE TRIGGER lists_share_id_required_on_update
BEFORE UPDATE OF share_id ON lists
FOR EACH ROW
WHEN NEW.share_id IS NULL
BEGIN
	SELECT RAISE(ABORT, 'share_id is required');
END;
