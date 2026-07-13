# Architecture

## System overview

```
                        ┌─────────────────────────────────────────────┐
                        │                INGESTION                    │
 photo / voice / text   │                                             │
 ──── Telegram ────────▶│  Cloudflare Worker (webhook)                │
                        │   1. store raw update in `ingestions`      │
                        │   2. fetch media from Telegram file API    │
                        │   3. Gemini Flash → structured JSON        │
                        │   4. reply: parsed txn + Confirm/Edit/     │
                        │      Discard inline buttons                │
                        └──────────────────┬──────────────────────────┘
                                           │ on confirm
                                           ▼
                        ┌─────────────────────────────────────────────┐
                        │                 STORAGE                     │
                        │  Supabase Postgres (normalized schema)      │
                        │  Supabase Storage (receipt images)          │
                        └──────────────────┬──────────────────────────┘
                                           │ nightly GitHub Action
                                           ▼
                        ┌─────────────────────────────────────────────┐
                        │             SEMANTIC LAYER                  │
                        │  dbt-core: staging → marts (monthly spend,  │
                        │  category rollups, needs/wants, fixed/var)  │
                        │  docs/SEMANTIC_LAYER.md = metric contract   │
                        └───────┬──────────────────────┬──────────────┘
                                ▼                      ▼
                  ┌───────────────────────┐  ┌─────────────────────────┐
                  │      CONSUMPTION      │  │      AGENT LAYER        │
                  │ Grafana Cloud         │  │ Claude Code (this repo) │
                  │ dashboards; Supabase  │  │ Postgres MCP + subagents│
                  │ SQL editor (ad hoc)   │  │ analyst / sql / coach   │
                  └───────────────────────┘  └─────────────────────────┘
```

## Component choices and rationale

### Ingestion — Telegram Bot + Cloudflare Workers
- Telegram Bot API is free, has first-class photo/voice/file APIs, and inline
  keyboards for the confirm loop.
- Cloudflare Workers free tier: 100k requests/day, webhook model (no polling
  server to keep alive), TypeScript, secrets management built in.
- The Worker is intentionally thin: validate → persist raw → call LLM → reply.
  All state lives in Postgres, so the Worker stays stateless and testable.
- Idempotency: `ingestions.telegram_update_id` is UNIQUE; Telegram retries
  webhooks, and the unique constraint makes retries harmless.

### Extraction — Gemini Flash (free tier)
- Handles images (receipts) and audio (voice notes) natively — one API for all
  three input types. Free-tier quota comfortably covers personal volume
  (a handful of requests/day).
- Prompt includes the live category/subcategory/tag taxonomy (fetched from
  Postgres) and requests structured JSON output matching the `extraction`
  schema: `{type, amount, currency, date, description, category, subcategory,
  merchant, tags[], funded_by, confidence}`.
- Low confidence → the bot's reply highlights the uncertain fields for editing.

### Storage — Supabase Postgres
- Free tier: 500 MB Postgres + 1 GB Storage. Years of personal transactions fit
  in a few MB.
- Chosen over Neon because receipt images need object storage (Storage bucket,
  path stored in `ingestions.media_path`) and Studio's SQL editor doubles as
  the ad-hoc query console the project wants.
- Note: free projects pause after ~1 week of inactivity; daily logging keeps it
  warm, and the nightly dbt Action acts as a heartbeat.

### Schema (DDL sketch)

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
  media_path         text,                        -- Supabase Storage object
  extraction         jsonb,                       -- LLM structured output
  status             text not null default 'pending'
                     check (status in ('pending','confirmed','discarded')),
  transaction_id     uuid references transactions(id),
  created_at         timestamptz not null default now()
);
```

Design notes:
- Notion's "Financial Future" rows become `type = 'transfer'` with a
  `to_account_id` — savings are not expenses.
- `bucket` and `cadence` live on `subcategories` (they're properties of what
  kind of spend it is, exactly like the Notion formulas derived them).
- Money is `numeric`, never `float`.
- `ingestions` separates "what arrived" from "what I confirmed" — auditability,
  reprocessing (better prompts later can re-run old receipts), and a natural
  place for the confirm/edit state machine.

### Semantic layer — dbt-core + SEMANTIC_LAYER.md
- dbt project in `dbt/`: `staging/` (light renames from raw tables) →
  `marts/` (fct_monthly_spend, fct_category_month, dim views).
- Canonical metric definitions in `docs/SEMANTIC_LAYER.md`, e.g.
  **discretionary spend** = expenses where funded_by = 'self' AND subcategory
  ≠ Rent; **savings rate** = transfers / income per month. Both dbt models
  and the agent reference this file so numbers agree everywhere.
- Runs free on GitHub Actions nightly cron (public repo = unlimited minutes).

### Consumption — Grafana Cloud + Supabase Studio
- Grafana Cloud free tier connects straight to Supabase Postgres; rebuild the
  Notion views first: cumulative monthly spend (ex-rent, ex-externally-funded),
  fixed-expenses donut, most-expensive-wants bar, per-day spend line.
- Ad-hoc SQL: Supabase Studio editor.
- Optional later: Evidence.dev static site (built by Actions, hosted on
  Cloudflare Pages) for a shareable, versioned report layer.

### Agent layer — Claude Code in this repo
- `.mcp.json` configures a Postgres MCP server (read-only role pointed at
  Supabase) so Claude can query the warehouse directly.
- `.claude/agents/` defines subagents:
  - `data-analyst` — answers questions, produces charts/tables from marts
  - `sql-runner` — translates NL → SQL against the semantic layer, read-only
  - `spend-coach` — monthly reviews: anomalies, category drift, savings rate
- CLAUDE.md + SEMANTIC_LAYER.md give any session full context, so the agent
  is reproducible from a fresh clone. Marginal cost: $0 (existing Claude plan).

## Security
- Public repo: all credentials in Worker secrets / Actions secrets / `.env`.
- The Worker validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header and
  ignores updates from any chat ID other than the owner's.
- The MCP database role is read-only (`GRANT SELECT` on marts only).
