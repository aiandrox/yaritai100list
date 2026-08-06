CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "lists_visibility_check" CHECK("lists"."visibility" in ('private', 'unlisted', 'public'))
);
