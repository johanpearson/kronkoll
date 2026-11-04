-- Försäkringskassans parametrar för 2026 och 2027 (antagande A-5, KK-23-A). Ett nytt år läggs till i en
-- egen migrering när regeringen har fastställt prisbasbeloppet, med pressmeddelandet som källa.
-- Taket är 10 prisbasbelopp, och föräldrapenningen är SGI × 0,97 × 0,80 / 365. Med 2026 års tak ger det
-- 1 259 kr per dag, samma högsta belopp som Försäkringskassan anger för 2026.
INSERT INTO `income_parameters` (`year`, `price_base_amount_minor`, `sgi_cap_multiplier`, `benefit_rate`, `sgi_factor`, `source_url`) VALUES
  (2026, 5920000, 10, 0.8, 0.97, 'https://www.regeringen.se/pressmeddelanden/2025/09/prisbasbelopp-for-2026-faststallt/'),
  (2027, 5960000, 10, 0.8, 0.97, 'https://www.regeringen.se/pressmeddelanden/2026/09/prisbasbeloppfor-2027-faststallt/');