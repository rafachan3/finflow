-- Migration 0001: full schema. Contract: docs/DATA_MODEL.md — the two must
-- agree; change both in the same commit. Never edit this file after merge;
-- correct forward with a new migration.

create type transaction_type as enum ('income', 'expense', 'transfer');
create type bucket_type      as enum ('needs', 'wants');

create table categories (
  id   smallint generated always as identity primary key,
  name text not null unique
);

create table subcategories (
  id             smallint generated always as identity primary key,
  category_id    smallint not null references categories(id),
  name           text not null,
  default_bucket bucket_type,      -- extraction hint only; the authoritative
                                   -- bucket is per line item
  unique (category_id, name)
);

-- Third classification level, only for categories where it earns its keep
-- (see docs/TAXONOMY.md). Scoped to a category, not a subcategory: Food &
-- drink item types apply across all its channels.
create table item_types (
  id          smallint generated always as identity primary key,
  category_id smallint not null references categories(id),
  name        text not null,
  unique (category_id, name)
);

create table merchants (
  id      integer generated always as identity primary key,
  name    text not null unique,
  aliases text[] not null default '{}'            -- for LLM normalization
);

-- Venue / channel of purchase (Supermarket, Coffee Shop, Pharmacy, ...).
-- Single-valued per transaction, unlike tags.
create table venues (
  id   smallint generated always as identity primary key,
  name text not null unique
);

create table income_sources (
  id   smallint generated always as identity primary key,
  name text not null unique                       -- values seeded locally
);

create table accounts (
  id   smallint generated always as identity primary key,
  name text not null unique,                      -- values seeded locally
  kind text not null                              -- savings | investment
);

-- Who paid. The tracked seed contains only 'self'; additional sources are
-- personal and live in the untracked overlay.
create table funding_sources (
  id   smallint generated always as identity primary key,
  name text not null unique
);

-- Free-form context only (Travel, Social, Avoidable, ...). Venues and
-- merchants are NOT tags.
create table tags (
  id   smallint generated always as identity primary key,
  name text not null unique
);

create table transactions (
  id                uuid primary key default gen_random_uuid(),
  occurred_on       date not null,
  type              transaction_type not null,
  amount            numeric(12,2) not null check (amount > 0),
  currency          char(3) not null default 'CAD',
  description       text not null,
  merchant_id       integer  references merchants(id),
  venue_id          smallint references venues(id),
  income_source_id  smallint references income_sources(id),
  to_account_id     smallint references accounts(id),
  funding_source_id smallint not null references funding_sources(id),
  is_recurring      boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now(),
  check (type <> 'income'   or income_source_id is not null),
  check (type <> 'transfer' or to_account_id    is not null)
);
create index on transactions (occurred_on);

-- Receipt line items. Classification lives here, not on the header, because
-- one receipt can span categories and one meal can span item types. A simple
-- quick-log expense gets exactly one line mirroring the header.
create table transaction_items (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  description    text not null,
  amount         numeric(12,2) not null check (amount > 0),
  subcategory_id smallint not null references subcategories(id),
  item_type_id   smallint references item_types(id),
  bucket         bucket_type not null
);
create index on transaction_items (transaction_id);
create index on transaction_items (subcategory_id);

create table transaction_tags (
  transaction_id uuid     not null references transactions(id) on delete cascade,
  tag_id         smallint not null references tags(id),
  primary key (transaction_id, tag_id)
);

-- Audit + human-in-the-loop staging. Every Telegram message lands here first.
create table ingestions (
  id                 uuid primary key default gen_random_uuid(),
  source             text not null check (source in ('photo','voice','text')),
  telegram_update_id bigint not null unique,      -- idempotent webhook retries
  raw_payload        jsonb not null,              -- full Telegram update
  media_path         text,                        -- S3 object key
  extraction         jsonb,                       -- LLM structured output
  status             text not null default 'pending'
                     check (status in ('pending','confirmed','discarded')),
  transaction_id     uuid references transactions(id),
  created_at         timestamptz not null default now()
);
