-- 手で書いたマイグレーション。drizzle-kit の生成物をそのまま使えなかった。
--
-- 生成されたのは次の1文だけだった:
--   ALTER TABLE `lists` ADD `user_id` text NOT NULL REFERENCES users(id);
--
-- これは2つの意味で使えない:
--   1. SQLite は NOT NULL の列を DEFAULT 無しで ADD COLUMN できない（行が無くても DDL で失敗する）
--   2. ON DELETE CASCADE が落ちている。スキーマに書いた cascade が SQL に出ていない
--
-- lists は local / remote ともに 0 行だったので作り直す。
-- 行がある場合はそもそも移行できない（持ち主を決められないため）。
DROP TABLE `lists`;--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lists_visibility_check" CHECK("lists"."visibility" in ('private', 'unlisted', 'public'))
);
