-- ON DELETE SET NULL skrivs för hand: drizzle-kit tar bort det i ALTER TABLE, och då går ett konto med kopplade
-- överföringar inte att ta bort.
CREATE TABLE `known_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`match_patterns` text DEFAULT '[]' NOT NULL,
	`category_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "known_accounts_name" CHECK(length(trim(name)) BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `known_account_id` text REFERENCES known_accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `known_account_source` text;