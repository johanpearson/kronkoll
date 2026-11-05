CREATE TABLE `loans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lender` text,
	`balance_minor` integer NOT NULL,
	`interest_rate_bp` integer NOT NULL,
	`rate_fixed_until` text,
	`amortization_minor` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "loans_name" CHECK(length(trim(name)) BETWEEN 1 AND 60),
	CONSTRAINT "loans_lender" CHECK(lender IS NULL OR length(lender) <= 60),
	CONSTRAINT "loans_balance" CHECK(balance_minor >= 0),
	CONSTRAINT "loans_rate" CHECK(interest_rate_bp BETWEEN 0 AND 10000),
	CONSTRAINT "loans_amortization" CHECK(amortization_minor >= 0),
	CONSTRAINT "loans_rate_fixed_until" CHECK(rate_fixed_until IS NULL OR rate_fixed_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
