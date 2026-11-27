-- Kontoroller (KK-53). Kolumnen läggs till i stället för att bygga om tabellen: att radera accounts skulle
-- kaskadera till transaktionerna. Rollen sätts från de gamla brytarna (KK-53-B): ett konto som inte räknas med
-- blir Uteslutet, ett sparkonto Buffert och resten Inkomst/Utgift. included och saving tas bort senare.
ALTER TABLE `accounts` ADD `role` text DEFAULT 'spending' NOT NULL CONSTRAINT "accounts_role" CHECK(role IN ('spending', 'buffer', 'excluded'));--> statement-breakpoint
UPDATE `accounts` SET `role` = CASE WHEN `included` = 0 THEN 'excluded' WHEN `saving` = 1 THEN 'buffer' ELSE 'spending' END;
