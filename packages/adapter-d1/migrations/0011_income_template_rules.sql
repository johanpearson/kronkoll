-- Mallregler för inkomster (KK-22-A). Genererade från INCOME_TEMPLATE_RULES i packages/domain. Testet i
-- src/seed.test.ts kontrollerar att de stämmer överens. Reglerna sätter bara inkomsttyp, ingen kategori.
-- Antagande A-6: hur Försäkringskassan och lönen syns hos banken är inte bekräftat med riktig data än.
INSERT INTO `category_rules` (`id`, `match`, `pattern`, `category_id`, `income_type`, `source`) VALUES
  ('inkomst-forsakringskassan', 'counterparty_prefix', 'FÖRSÄKRINGSKASSAN', NULL, 'parental_benefit', 'template'),
  ('inkomst-forsakringskassan-ascii', 'counterparty_prefix', 'FORSAKRINGSKASSAN', NULL, 'parental_benefit', 'template'),
  ('inkomst-lon', 'counterparty_prefix', 'LÖN', NULL, 'salary', 'template'),
  ('inkomst-lon-ascii', 'counterparty_prefix', 'LON', NULL, 'salary', 'template');