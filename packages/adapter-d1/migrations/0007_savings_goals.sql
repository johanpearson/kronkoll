CREATE TABLE `goal_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`date` text NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `savings_goals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "goal_contributions_date" CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "goal_contributions_amount" CHECK(amount_minor <> 0)
);
--> statement-breakpoint
CREATE INDEX `goal_contributions_goal_date` ON `goal_contributions` (`goal_id`,`date`);--> statement-breakpoint
CREATE TABLE `savings_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`target_minor` integer NOT NULL,
	`target_date` text,
	`source` text NOT NULL,
	`account_id` text,
	`initial_minor` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "savings_goals_source" CHECK(source IN ('manual', 'account')),
	CONSTRAINT "savings_goals_manual_has_no_account" CHECK(source = 'account' OR account_id IS NULL),
	CONSTRAINT "savings_goals_target" CHECK(target_minor > 0),
	CONSTRAINT "savings_goals_initial" CHECK(initial_minor >= 0),
	CONSTRAINT "savings_goals_name" CHECK(length(trim(name)) BETWEEN 1 AND 60),
	CONSTRAINT "savings_goals_target_date" CHECK(target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
