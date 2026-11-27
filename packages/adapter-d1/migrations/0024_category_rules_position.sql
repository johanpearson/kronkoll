ALTER TABLE `category_rules` ADD `position` integer;--> statement-breakpoint
-- Befintliga egna kategoriregler får platser i den inbyggda prioriteten (exakt, prefix, innehåller, längre
-- mönster först, sedan id), så att samma regel vinner som förut tills användaren ordnar om (KK-58-C).
UPDATE `category_rules` SET `position` = (
	SELECT `n` FROM (
		SELECT `id`, ROW_NUMBER() OVER (
			ORDER BY CASE `match` WHEN 'counterparty_exact' THEN 0 WHEN 'counterparty_prefix' THEN 1 ELSE 2 END, length(`pattern`) DESC, `id`
		) - 1 AS `n`
		FROM `category_rules`
		WHERE `source` = 'learned' AND `action` = 'categorize' AND `category_id` IS NOT NULL
	) AS `ordered` WHERE `ordered`.`id` = `category_rules`.`id`
) WHERE `source` = 'learned' AND `action` = 'categorize' AND `category_id` IS NOT NULL;
