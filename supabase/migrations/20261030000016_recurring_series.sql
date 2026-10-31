-- Migration 0016: recurring series (Phase 4.5).
--
-- A recurring series (a bill, a salary, a monthly transfer) is a row here, and
-- a payment belongs to it through transactions.recurring_series_id.
-- transactions.is_recurring stays, because the marts and the contract read it
-- (SEMANTIC_LAYER.md, fixed_base_burn), and becomes a consequence of the link.
--
-- The tables ship empty: the owner's series live only in their database.
-- Anything derived from history (anchor day, window, typical amount, missed
-- count) is computed by lambda/src/recurring.ts on read and never stored.
--
-- Grants: the default privileges of 0003 and 0013 make every new table
-- readable by finflow_readonly and finflow_dbt. 0015 removed the migrating
-- role's default privileges for anon and authenticated, so these tables are
-- not granted to them (dbt test data_api_roles_reach_nothing).
--
-- Needs Postgres 15 or later (ON DELETE SET NULL with a column list) and the
-- btree_gist extension (integer equality inside a GiST exclusion constraint).
-- The extension goes in schema extensions, where Supabase keeps extensions,
-- so its functions stay out of public.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- The owner confirms a cadence when declaring a series, so a series with too
-- little history to detect one (a bill logged once or twice) still has one.
create type recurring_cadence as enum
  ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly');

-- Match keys are what a payment must share to be offered as this series:
-- the income source for income, the accounts for a transfer. An expense
-- matches on its merchant, its subcategory, or its description against the
-- name, the keywords and the descriptions already linked (token overlap, not
-- an exact string; recurring.ts), so the name alone is enough of a key.
create table recurring_series (
  id               integer generated always as identity primary key,
  name             text not null check (btrim(name) <> '' and length(name) <= 60),
  kind             transaction_type not null,
  cadence          recurring_cadence not null,
  amount_varies    boolean not null default false,     -- true: no typical amount, no band
  merchant_id      integer  references merchants(id),
  subcategory_id   smallint references subcategories(id),
  income_source_id smallint references income_sources(id),
  from_account_id  smallint references accounts(id),   -- null = chequing, as on transactions
  to_account_id    smallint references accounts(id),
  keywords         text[] not null default '{}',       -- extra phrases a description may use
  created_at       timestamptz not null default now(),
  unique (id, kind),                                   -- target of the composite FK below
  check (kind <> 'income' or income_source_id is not null),
  check (kind =  'income' or income_source_id is null),
  check (kind <> 'transfer'
         or (coalesce(from_account_id, to_account_id) is not null
             and from_account_id is distinct from to_account_id)),
  check (kind =  'transfer' or (from_account_id is null and to_account_id is null)),
  check (kind =  'expense' or (merchant_id is null and subcategory_id is null))
);
create unique index recurring_series_name_key on recurring_series (lower(btrim(name)));

-- The link. The composite FK makes a linked transaction's type equal its
-- series' kind, so a salary cannot join an expense series. MATCH SIMPLE: an
-- unlinked row (null id) is not checked. SET NULL with a column list clears
-- only the id when a series is deleted, never the transaction's type.
alter table transactions add column recurring_series_id integer;
alter table transactions add constraint transactions_recurring_series_fkey
  foreign key (recurring_series_id, type) references recurring_series (id, kind)
  on delete set null (recurring_series_id);
create index transactions_recurring_series_idx
  on transactions (recurring_series_id) where recurring_series_id is not null;

-- "This payment is not that series": a candidate the owner unticked. It is
-- never offered to that series again.
create table recurring_exclusions (
  series_id      integer not null references recurring_series(id) on delete cascade,
  transaction_id uuid    not null references transactions(id)     on delete cascade,
  excluded_at    timestamptz not null default now(),
  primary key (series_id, transaction_id)
);
create index recurring_exclusions_transaction_idx on recurring_exclusions (transaction_id);

-- Dated pauses, [paused_from, resumed_on). resumed_on null means still
-- paused; a future resumed_on is a pause with an end date. An expected
-- payment whose centre falls inside a pause is never counted as missed.
-- No two pauses of one series overlap.
create table recurring_pauses (
  id          integer generated always as identity primary key,
  series_id   integer not null references recurring_series(id) on delete cascade,
  paused_from date not null,
  resumed_on  date,
  check (resumed_on is null or resumed_on > paused_from),
  constraint recurring_pauses_no_overlap
    exclude using gist (series_id with =, daterange(paused_from, resumed_on, '[)') with &&)
);

-- "Not this time": one expected payment that will not happen. due_on is the
-- expected date; it settles the expected payment nearest to it.
create table recurring_skips (
  series_id  integer not null references recurring_series(id) on delete cascade,
  due_on     date not null,
  skipped_at timestamptz not null default now(),
  primary key (series_id, due_on)
);

-- Detector proposals the owner answered "not recurring", by the group key
-- recurring.ts computes (income source, accounts, merchant, or the words a
-- group of descriptions share), so the same group is not proposed again.
create table recurring_dismissed (
  group_key    text primary key,
  dismissed_at timestamptz not null default now()
);

-- is_recurring follows the link. Transitional: linking or unlinking sets
-- the flag, and so does any write of the flag itself, so a linked row cannot
-- be marked non-recurring. An INSERT with no link keeps the value it was
-- given, so the bot's Confirm (which still writes Gemini's guess) and the
-- legacy flags the owner's backfill reviews keep working. Updates of other
-- columns (link-on-add sets merchant_id) do not fire it. Migration 0017,
-- after the backfill, makes the flag exactly the link with a CHECK.
create function transactions_sync_recurring() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.recurring_series_id is not null then
      new.is_recurring := true;
    end if;
  else
    new.is_recurring := new.recurring_series_id is not null;
  end if;
  return new;
end $$;

create trigger transactions_sync_recurring
  before insert or update of recurring_series_id, is_recurring on transactions
  for each row execute function transactions_sync_recurring();
