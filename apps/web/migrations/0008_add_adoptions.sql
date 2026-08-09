-- 取り入れの記録（#233 / 親 #10）。
--
-- 🔴 **`source_text` は外部キーではない。** 取り入れ元を「項目」ではなく「本文」で持つ
-- （2026-08-09 の利用者の判断）。プールの単位が本文だから。
-- これで「取り入れ元が消えた / 非公開になった」ときの後始末が要らなくなる。
--
-- 🔴 **`adopter_item_id` は一意 + `on delete cascade`。**
-- 1項目に取り入れ元は1つ。取り入れた項目を消したら記録も消し、
-- 「もう存在しない取り入れ」が人気指標に効き続けないようにする。
--
-- drizzle-kit の生成そのまま（新しい表なので、0002 / 0007 のような手当ては要らない）。
CREATE TABLE `adoptions` (
	`id` text PRIMARY KEY NOT NULL,
	`adopter_item_id` text NOT NULL,
	`source_text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`adopter_item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adoptions_adopter_item_id_unique` ON `adoptions` (`adopter_item_id`);--> statement-breakpoint
CREATE INDEX `adoptions_source_text` ON `adoptions` (`source_text`);