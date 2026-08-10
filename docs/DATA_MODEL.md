# Data model

The schema contract. `supabase/migrations/` must agree with this file; change
both in the same commit. For *why* the storage layer looks like this, see
[ARCHITECTURE.md](ARCHITECTURE.md); for when each choice was made, see
[DECISIONS.md](DECISIONS.md).

## Shape in one paragraph

Transactions are `income | expense | transfer`. A two-level taxonomy of 10
categories → 37 subcategories classifies spend, with `bucket` (needs/wants) and
`cadence` (fixed/variable) stored as attributes of the *subcategory*. Merchants
are first-class rows with an alias array for LLM normalization. Tags stay for
free-form context (Travel, Social, Avoidable…). `funded_by` records who paid.
Every Telegram message lands in `ingestions` before it can become a confirmed
transaction.

## Migrated from Notion

The system replaces a Notion "Transactions" database. Mapping:

| Notion | Postgres |
|---|---|
| "Financial Future" rows | `type = 'transfer'` with a `to_account_id` — savings are not expenses |
| `bucket` / `cadence` formulas | Columns on `subcategories` |
| Merchants mixed into the tag list | `merchants` table, referenced by `transactions.merchant_id` |
| Remaining context tags | `tags` + `transaction_tags` |
| "Paid by family?" checkbox | `funded_by` enum (`self` \| `other`) |

The Notion database and data-source identifiers used for the one-off import are
in the untracked `CLAUDE.local.md`, not here.

## DDL

```sql
create type transaction_type as enum ('income', 'expense', 'transfer');
create type bucket_type      as enum ('needs', 'wants');
create type cadence_type     as enum ('fixed', 'variable');
create type funding_source   as enum ('self', 'other');

create table categories (
  id   smallint generated always as identity primary key,
  name text not null unique                       -- Food, Transit, Bills, ...
);

create table subcategories (
  id          smallint generated always as identity primary key,
  category_id smallint not null references categories(id),
  name        text not null,                      -- Groceries, Rent, Bixi, ...
  bucket      bucket_type,                        -- was a Notion formula
  cadence     cadence_type,                       -- was a Notion formula
  unique (category_id, name)
);

create table merchants (
  id      integer generated always as identity primary key,
  name    text not null unique,                   -- Costco, Amazon, Dollarama...
  aliases text[] not null default '{}'            -- for LLM normalization
);

create table income_sources (
  id   smallint generated always as identity primary key,
  name text not null unique                       -- Salary, Family support, Refund...
);

create table accounts (
  id   smallint generated always as identity primary key,
  name text not null unique,                      -- Savings, Investment
  kind text not null                              -- savings | investment
);

create table transactions (
  id               uuid primary key default gen_random_uuid(),
  occurred_on      date not null,
  type             transaction_type not null,
  amount           numeric(12,2) not null check (amount > 0),
  currency         char(3) not null default 'CAD',
  description      text not null,
  subcategory_id   smallint references subcategories(id),
  merchant_id      integer  references merchants(id),
  income_source_id smallint references income_sources(id),
  to_account_id    smallint references accounts(id),
  funded_by        funding_source not null default 'self',
  notes            text,
  created_at       timestamptz not null default now(),
  check (type <> 'expense'  or subcategory_id   is not null),
  check (type <> 'income'   or income_source_id is not null),
  check (type <> 'transfer' or to_account_id    is not null)
);
create index on transactions (occurred_on);
create index on transactions (subcategory_id);

create table tags (
  id   smallint generated always as identity primary key,
  name text not null unique                       -- Travel, Social, Avoidable...
);

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
```

## Extraction payload

`ingestions.extraction` holds the LLM's structured output:

```json
{
  "type": "expense",
  "amount": "12.50",
  "currency": "CAD",
  "date": "2026-08-08",
  "description": "lunch",
  "category": "Food",
  "subcategory": "Eating out",
  "merchant": "Chipotle",
  "tags": ["Social"],
  "funded_by": "self",
  "confidence": 0.91
}
```

Low confidence means the bot's reply highlights the uncertain fields for
editing before the user can confirm.

## Invariants

- Money is `numeric(12,2)`. Never float.
- A row in `transactions` exists only because a human pressed Confirm on the
  corresponding `ingestions` row.
- `ingestions.telegram_update_id` is UNIQUE — webhook retries are harmless.
- Migrations are never edited after merge; correct forward with a new one.
