-- Personal seed overlay TEMPLATE.
--
-- Copy to supabase/seed.personal.sql (gitignored — it must never be
-- committed), replace the placeholder values with your own, and apply once
-- against your database:
--
--   psql "$DATABASE_URL" -f supabase/seed.personal.sql
--
-- The tracked taxonomy seed (migration 0002) covers everything generic;
-- this overlay holds only the lookup values that are specific to you.

-- Where your transfers go (type = 'transfer' transactions).
-- kind is 'savings' or 'investment'.
insert into accounts (name, kind) values
  ('Emergency fund', 'savings'),
  ('Retirement account', 'investment');

-- Where your income comes from.
insert into income_sources (name) values
  ('Salary'),
  ('Refund');

-- Who pays besides you ('self' is already seeded by migration 0002).
insert into funding_sources (name) values
  ('family');

-- Context tags beyond the generic set (people, projects, ...).
insert into tags (name) values
  ('Partner');

-- Recurring merchants you want normalized, with the aliases the LLM
-- should map onto them (e.g. how the name appears on receipts).
insert into merchants (name, aliases) values
  ('Costco', '{"COSTCO WHOLESALE"}'),
  ('Amazon', '{"AMZN Mktp", "AMAZON.CA"}');
