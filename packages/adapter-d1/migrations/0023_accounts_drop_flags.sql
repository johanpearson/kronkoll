-- De gamla brytarna Räknas med och Sparkonto tas bort (KK-53-B). Rollen ersatte dem i 0021, och varken API:t
-- eller appen läser dem längre. DROP COLUMN bygger inte om tabellen, så transaktionerna rörs inte.
ALTER TABLE `accounts` DROP COLUMN `included`;--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `saving`;