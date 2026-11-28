ALTER TABLE `loans` ADD `match_patterns` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `loans` ADD `category_id` text REFERENCES categories(id);--> statement-breakpoint
-- ON DELETE SET NULL skrivs för hand: drizzle-kit tar bort det i ALTER TABLE, och då går ett lån med kopplade
-- betalningar inte att ta bort (KK-59-B).
ALTER TABLE `transactions` ADD `loan_id` text REFERENCES loans(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `loan_source` text;
