-- KK-39-C: regler kan ha åtgärden Räkna inte. SQLite kan inte ändra en CHECK, så tabellen byggs om.
-- Ingen tabell refererar category_rules, så främmande nycklar behöver inte stängas av (D1 tillåter det inte).
CREATE TABLE `__new_category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`match` text NOT NULL,
	`pattern` text NOT NULL,
	`category_id` text,
	`income_type` text,
	`source` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`action` text DEFAULT 'categorize' NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "category_rules_match" CHECK(match IN ('counterparty_prefix', 'counterparty_exact', 'description_contains', 'amount_range')),
	CONSTRAINT "category_rules_source" CHECK(source IN ('template', 'learned')),
	CONSTRAINT "category_rules_action" CHECK(action IN ('categorize', 'exclude')),
	CONSTRAINT "category_rules_target" CHECK((action = 'categorize' AND (category_id IS NOT NULL OR income_type IS NOT NULL)) OR (action = 'exclude' AND category_id IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_category_rules`("id", "match", "pattern", "category_id", "income_type", "source", "priority", "hits") SELECT "id", "match", "pattern", "category_id", "income_type", "source", "priority", "hits" FROM `category_rules`;--> statement-breakpoint
DROP TABLE `category_rules`;--> statement-breakpoint
ALTER TABLE `__new_category_rules` RENAME TO `category_rules`;
