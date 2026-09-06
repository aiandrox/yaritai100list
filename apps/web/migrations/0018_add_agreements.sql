CREATE TABLE `agreements` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`effective_on` text NOT NULL,
	`agreed_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agreements_user_id_effective_on_idx` ON `agreements` (`user_id`,`effective_on`);