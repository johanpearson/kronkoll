-- Preliminära dragningar från Skandia kom med minustecken och CRDT och sparades som inkomster (rättat i
-- adapter-enablebanking). De känns igen på att de är preliminära, positiva och saknar text. De tas bort här
-- och hämtas igen med rätt tecken vid nästa synk, eftersom preliminära alltid läses om.
DELETE FROM `transactions` WHERE `status` = 'pending' AND `amount_minor` > 0 AND `counterparty` = '' AND `description` = '';
