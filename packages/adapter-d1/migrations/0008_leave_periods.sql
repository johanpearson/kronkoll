CREATE TABLE `income_parameters` (
	`year` integer PRIMARY KEY NOT NULL,
	`price_base_amount_minor` integer NOT NULL,
	`sgi_cap_multiplier` real NOT NULL,
	`benefit_rate` real NOT NULL,
	`sgi_factor` real NOT NULL,
	`source_url` text NOT NULL,
	CONSTRAINT "income_parameters_year" CHECK(year BETWEEN 2000 AND 2100),
	CONSTRAINT "income_parameters_price_base" CHECK(price_base_amount_minor > 0),
	CONSTRAINT "income_parameters_cap" CHECK(sgi_cap_multiplier > 0),
	CONSTRAINT "income_parameters_rate" CHECK(benefit_rate > 0 AND benefit_rate <= 1),
	CONSTRAINT "income_parameters_factor" CHECK(sgi_factor > 0 AND sgi_factor <= 1),
	CONSTRAINT "income_parameters_source" CHECK(source_url LIKE 'https://%')
);
--> statement-breakpoint
CREATE TABLE `leave_periods` (
	`id` text PRIMARY KEY NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`days_per_week` real NOT NULL,
	`sgi_annual_minor` integer NOT NULL,
	`employer_topup_pct` real DEFAULT 0 NOT NULL,
	`tax_rate_pct` real NOT NULL,
	`override_net_monthly_minor` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "leave_periods_from" CHECK(from_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "leave_periods_to" CHECK(to_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "leave_periods_order" CHECK(to_date >= from_date),
	CONSTRAINT "leave_periods_days" CHECK(days_per_week BETWEEN 0 AND 7),
	CONSTRAINT "leave_periods_sgi" CHECK(sgi_annual_minor >= 0),
	CONSTRAINT "leave_periods_topup" CHECK(employer_topup_pct BETWEEN 0 AND 100),
	CONSTRAINT "leave_periods_tax" CHECK(tax_rate_pct BETWEEN 0 AND 100),
	CONSTRAINT "leave_periods_override" CHECK(override_net_monthly_minor IS NULL OR override_net_monthly_minor >= 0)
);
