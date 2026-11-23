CREATE TABLE `guideline_one_off_periods` (
	`period` text PRIMARY KEY NOT NULL,
	CONSTRAINT "guideline_one_off_period" CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
);
--> statement-breakpoint
CREATE TABLE `guideline_overrides` (
	`category_id` text PRIMARY KEY NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "guideline_overrides_amount" CHECK(amount_minor >= 0)
);
--> statement-breakpoint
CREATE TABLE `guideline_settings` (
	`id` text PRIMARY KEY DEFAULT 'guidelines' NOT NULL,
	`mode` text DEFAULT 'none' NOT NULL,
	`saving_goal_minor` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "guideline_settings_single_row" CHECK(id = 'guidelines'),
	CONSTRAINT "guideline_settings_mode" CHECK(mode IN ('none', 'budget', 'saving')),
	CONSTRAINT "guideline_settings_goal" CHECK(saving_goal_minor >= 0)
);
