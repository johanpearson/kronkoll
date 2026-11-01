CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provider_uid` text,
	`iban_hash` text,
	`display_name` text NOT NULL,
	`type` text NOT NULL,
	`balance_minor` integer,
	`included` integer DEFAULT true NOT NULL,
	`sync_cursor` text,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "accounts_type" CHECK(type IN ('checking', 'credit_card', 'savings', 'loan', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_uid` ON `accounts` (`connection_id`,`provider_uid`);--> statement-breakpoint
CREATE TABLE `bank_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`aspsp_name` text,
	`session_id_enc` blob,
	`status` text DEFAULT 'pending_auth' NOT NULL,
	`consent_expires_on` text,
	`last_success_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "bank_connections_provider" CHECK(provider IN ('enablebanking', 'csv')),
	CONSTRAINT "bank_connections_status" CHECK(status IN ('pending_auth', 'active', 'expiring', 'expired', 'revoked')),
	CONSTRAINT "bank_connections_consent_date" CHECK(consent_expires_on IS NULL OR consent_expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE TABLE `budget_lines` (
	`period` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	PRIMARY KEY(`period`, `category_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "budget_lines_period" CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "budget_lines_amount" CHECK(amount_minor >= 0),
	CONSTRAINT "budget_lines_source" CHECK(source IN ('manual', 'copy_previous', 'average_3m'))
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`color` text,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "categories_kind" CHECK(kind IN ('expense', 'income', 'transfer'))
);
--> statement-breakpoint
CREATE INDEX `categories_parent` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`match` text NOT NULL,
	`pattern` text NOT NULL,
	`category_id` text,
	`income_type` text,
	`source` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "category_rules_match" CHECK(match IN ('counterparty_prefix', 'counterparty_exact', 'description_contains', 'amount_range')),
	CONSTRAINT "category_rules_source" CHECK(source IN ('template', 'learned')),
	CONSTRAINT "category_rules_target" CHECK(category_id IS NOT NULL OR income_type IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY DEFAULT 'settings' NOT NULL,
	`budget_period_start_day` integer DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'Europe/Stockholm' NOT NULL,
	CONSTRAINT "settings_single_row" CHECK(id = 'settings'),
	CONSTRAINT "settings_start_day" CHECK(budget_period_start_day BETWEEN 1 AND 28)
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text,
	`kind` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`updated_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	FOREIGN KEY (`connection_id`) REFERENCES `bank_connections`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sync_runs_kind" CHECK(kind IN ('cron', 'manual', 'initial', 'daily')),
	CONSTRAINT "sync_runs_status" CHECK(status IN ('running', 'ok', 'partial', 'failed')),
	CONSTRAINT "sync_runs_error_code" CHECK(error_code IS NULL OR (error_code <> '' AND error_code NOT GLOB '*[^A-Z0-9_]*'))
);
--> statement-breakpoint
CREATE INDEX `sync_runs_started` ON `sync_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `transaction_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transaction_splits_transaction` ON `transaction_splits` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_tx_id` text,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`transaction_date` text NOT NULL,
	`booking_date` text,
	`amount_minor` integer NOT NULL,
	`counterparty` text DEFAULT '' NOT NULL,
	`counterparty_norm` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category_id` text,
	`category_source` text DEFAULT 'none' NOT NULL,
	`income_type` text,
	`is_internal_transfer` integer DEFAULT false NOT NULL,
	`transfer_pair_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_pair_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "transactions_status" CHECK(status IN ('pending', 'booked', 'removed')),
	CONSTRAINT "transactions_category_source" CHECK(category_source IN ('manual', 'learned', 'template', 'none')),
	CONSTRAINT "transactions_income_type" CHECK(income_type IS NULL OR income_type IN ('salary', 'parental_benefit', 'other')),
	CONSTRAINT "transactions_dates" CHECK(transaction_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND (booking_date IS NULL OR booking_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
	CONSTRAINT "transactions_description_length" CHECK(length(description) <= 140)
);
--> statement-breakpoint
CREATE INDEX `transactions_account_date` ON `transactions` (`account_id`,`transaction_date`);--> statement-breakpoint
CREATE INDEX `transactions_fingerprint` ON `transactions` (`account_id`,`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_provider_id` ON `transactions` (`account_id`,`provider_tx_id`);--> statement-breakpoint
CREATE INDEX `transactions_category` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "users_theme" CHECK(theme IN ('system', 'light', 'dark'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email` ON `users` (`email`);