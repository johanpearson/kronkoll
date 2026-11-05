CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`topics` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_https" CHECK(endpoint LIKE 'https://%' AND length(endpoint) <= 1024),
	CONSTRAINT "push_subscriptions_keys" CHECK(length(p256dh) BETWEEN 1 AND 100 AND length(auth) BETWEEN 1 AND 30),
	CONSTRAINT "push_subscriptions_topics" CHECK(json_valid(topics) AND json_type(topics) = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `sent_notices` (
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`item` text NOT NULL,
	`sent_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`kind`, `scope`, `item`),
	CONSTRAINT "sent_notices_kind" CHECK(kind IN ('budget', 'consent'))
);
