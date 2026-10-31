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
-- kind is 'savings', 'investment' or 'debt'.
insert into accounts (name, kind) values
  ('Emergency fund', 'savings'),
  ('Retirement account', 'investment');

-- A loan you pay extra on is a 'debt' account: an extra payment is a
-- transfer into it, and the minimum payment stays an ordinary expense line.
-- insert into accounts (name, kind) values
--   ('Car loan', 'debt');

-- Where your income comes from.
insert into income_sources (name) values
  ('Salary'),
  ('Refund');

-- Income paid straight into a savings or investment account (interest, say)
-- names that account; every other source lands in chequing (null).
-- insert into income_sources (name, deposit_account_id) values
--   ('Savings interest', (select id from accounts where name = 'Emergency fund'));

-- Who pays besides you ('self' is already seeded by migration 0002).
insert into funding_sources (name) values
  ('family');

-- Context tags beyond the generic set (people, projects, ...).
insert into tags (name) values
  ('Partner');

-- Recurring merchants you want normalized, with the aliases the LLM
-- should map onto them (e.g. how the name appears on receipts).
insert into merchants (name, aliases) values
  ('Acme Mart', '{"ACME MART WHOLESALE"}'),
  ('Example Online', '{"EXAMPLE MKTP", "EXAMPLE.CA"}');
