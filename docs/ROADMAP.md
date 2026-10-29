# Roadmap

Each phase ends with something that works end-to-end. Don't start a phase
until the previous one's acceptance check passes. Update
[STATUS.md](STATUS.md) as phases land, and append to
[DECISIONS.md](DECISIONS.md) when a phase settles an open question.

## Phase 0 — Repo & accounts (≈1 evening)

- [x] `git init`, push to a public GitHub repo
- [x] Create accounts: AWS, Supabase, Grafana Cloud, Google AI Studio
      (Gemini API key), Telegram bot via @BotFather
      *(accounts, the bot, and API keys are manual — not terraformable)*
- [x] AWS account hygiene **before anything else**: root MFA, an IAM admin user
      or Identity Center user for daily use, region `ca-central-1`
- [x] Add MIT license, README stub pointing at docs/
- [x] `infra/` Terraform scaffold: pinned providers (aws, supabase, grafana),
      local state (gitignored — state holds secrets, repo is public)
- [x] `aws_budgets_budget` at $1/month with an email alert — the first AWS
      resource to exist, since AWS fails open on cost. Scoped to tag
      `Project=finflow` (not whole-account). Activate `Project` in Billing →
      Cost allocation tags when it appears (up to 24h after first tagged usage).

**Done when:** repo is on GitHub, all API keys exist (stored in a password
manager, none committed), and the budget alarm has fired a test notification.
**(Met 2026-08-10.)**

## Phase 1 — Database foundation (≈1–2 evenings)

- [x] Supabase project provisioned via Terraform (`infra/`); Supabase CLI
      linked (`supabase/migrations/` — schema stays in migrations, not Terraform)
- [x] Migration 0001: full schema from docs/DATA_MODEL.md
- [x] Seed migration: the generic taxonomy template from docs/TAXONOMY.md —
      categories, subcategories (with default buckets), item types, venues,
      context tags, and the 'self' funding source
- [x] Personal overlay: untracked `supabase/seed.personal.sql` (accounts,
      income sources, extra funding sources, personal tags, merchants),
      built from the tracked `.example` template and applied by hand
- [x] One-off import: Notion (via MCP) → raw JSON pages → generated SQL →
      `transactions` + `transaction_items`, June 2026 onward. The import
      tooling is untracked (`scripts/import/`, gitignored): it embeds the
      owner's personal taxonomy values and a fork starts from an empty
      database, so it has no template value
- [x] Read-only Postgres role for future MCP/Grafana use

**Done when:** `select count(*) from transactions` matches the Notion row
count for the imported date range and a spot-check of 10 random rows matches
Notion exactly.

## Phase 2 — Telegram walking skeleton, no LLM (≈2 evenings)

- [x] Terraform: Lambda + Function URL, IAM execution role, CloudWatch log
      group, SSM `SecureString` parameters (values written out of band, never
      as Terraform vars). Function ships with a bootstrap stub and
      `ignore_changes = [filename, source_code_hash]`
- [x] Terraform: GitHub OIDC provider + deploy role scoped to
      `lambda:UpdateFunctionCode` on this function only — no long-lived keys
- [x] Deploy workflow: push to `main` → esbuild bundle → zip →
      `aws lambda update-function-code`
- [x] Telegram webhook registered against the Function URL with a secret token
- [x] Chat-ID allowlist (owner only), chat ID read from Parameter Store
- [x] Text-only quick-log format: `12.50 lunch chipotle` → parsed with a dumb
      regex → `ingestions` row → reply with Confirm / Discard buttons
- [x] Confirm button → transaction inserted; Discard → status flip
- [x] Idempotency verified (replay the same update, no duplicate)

**Done when:** a text message becomes a confirmed row in Postgres from your
phone, the bot survives a webhook retry without duplicating, and a subsequent
`terraform plan` reports **no changes** (proving the deploy and Terraform are
not fighting over the function's code).

*Why before the LLM: the confirm loop, webhook plumbing, and DB writes are the
skeleton everything else hangs on. Ship the smallest loop first.*

## Phase 3 — LLM extraction (≈2–3 evenings)

- [x] 3a. Natural-language text via Gemini structured output: extractor
      (taxonomy from DB, including item_type) then bucket specialist
      (BUCKET_RULES from SSM); full Telegram preview + cents/taxonomy checks
      before Confirm *(phone-tested 2026-08-17)*
- [x] Terraform: S3 receipts bucket (Block Public Access, default encryption,
      Glacier IR lifecycle at 1 year) + `s3:PutObject` on the Lambda role
      *(applied 2026-08-20)*
- [x] 3b. Receipt photos: Telegram file API → Gemini vision → itemized total,
      merchant, date; image archived to S3, key in `ingestions.media_path`
      *(phone-tested 2026-08-28: Confirm wrote the ledger row; S3 object
      matches `ingestions.media_path`)*
- [x] 3c. Voice notes: Telegram OGG → Gemini audio input → same pipeline
      *(phone-tested 2026-08-29: Confirm wrote the ledger row; S3 `.ogg`
      matches `ingestions.media_path`; dateless warning and still-waiting
      on a follow-up voice both held)*
- [x] Date HITL: text with no date defaults to today (warning); photo with
      no date blocks Confirm; Fix date → `ingestions.status = awaiting_date`
      *(phone-tested 2026-08-18)*
- [x] S3 media keys: one bucket, prefix `{source}/{yyyy-mm}/{id}.{ext}`
      (persist month, America/Toronto). Existing flat `{id}.{ext}` keys
      stay. Do not add a second bucket; do not rename
      `finflow-receipts-*` (AWS has no rename).
      *(landed 2026-10-29)*
- [x] Funding source is expense-only: `funding_source_id` nullable;
      CHECK expense ⇒ not null, income/transfer ⇒ null. Backfill
      existing income and transfer rows to null. Confirm preview
      shows Funded by only on expenses. Migration 0007 and
      DATA_MODEL.md. *(applied 2026-08-30; phone-tested expense
      Funded by: self, income/transfer omit Funded by and store
      NULL; #18 defaults omitted expense funder to self)*
      Transfers do not get a “who funded this move” rule unless we
      add one later.
- [x] Edit flow: **Edit** button → `awaiting_edit`; next text is a
      freeform correction; Gemini patches the stored extraction (no
      media re-download). Amount, category, and line-level fixes. Fix
      date stays the dedicated date path. Migration 0008.
      *(applied; phone-tested 2026-09-08: amount, category, still-waiting
      photo; #19)*
- [x] Multi-event message: one text, voice, or photo+caption that
      describes 2+ independent ledger headers → N pending ingestions
      and N Confirm cards. A grocery breakdown (several SKUs) plus an
      unrelated drink or a separate income in the same message is two
      headers: the trip stays one expense with lines; the extra event
      is its own row. After Edit. A grocery trip
      alone is already one expense with lines on every channel. Covers two
      merchants in one message ("$3 at the dollar store and $5 at the
      pharmacy" → two cards).
      *(merged #28; migration 0009; DECISIONS.md 2026-10-12. Accepted
      by the Phase 3.6 journeys in `lambda/tests/journeys/`)*
- [x] Context notes: the *why* behind a purchase ("too lazy to cook",
      "overslept, couldn't pack lunch") extracted in the owner's words
      into the existing `transactions.notes`, shown on the card,
      written on Confirm. Free text for agents; no reason taxonomy.
      Before multi-event. *(phone-tested 2026-10-12: text with and
      without a reason, receipt with and without a caption, Edit,
      voice; #23)*
- [x] Log Gemini token usage per request into `ingestions.extraction`,
      plus `meta` (model + sha256 of extractor, taxonomy, bucket prompt,
      and rules). No eval mart until Phase 4.

**Done when:** photo of a real receipt and a voice note each produce a correct
confirmed transaction with ≤1 manual correction on average, and the image is
retrievable from S3 at the key recorded in `ingestions.media_path`.

## Phase 3.6 — Regression test suite (≈3–4 evenings)

Every behaviour gets an automated test, and a PR that breaks one cannot
merge. Replaces manual phone tests; no test touches production
(DECISIONS.md 2026-10-28).

- [x] Integration: throwaway Postgres 17 in CI; every migration applies to
      an empty database; every `db.ts` path runs against real SQL
- [x] Journeys: the real handler against the throwaway database, a fake
      Telegram API and fake S3, with Gemini replayed from golden files
- [x] Eval: golden cases against live Gemini; a failure blocks the PR
- [x] Enforcement: `docs/TESTING.md` behaviour inventory checked in CI,
      coverage floor, required checks on `main` (unit, integration, eval,
      inventory; `enforce_admins` on; verified 2026-10-29 via
      `gh api repos/{owner}/{repo}/branches/main/protection`)
- [x] Post-deploy smoke: a wrong-secret request to the deployed Lambda
      returns 401 *(deploy run 40803017809: "wrong-secret request returned
      HTTP 401")*

**Done when:** a PR that deliberately breaks a behaviour is blocked by CI,
a clean PR passes with no manual step, and every inventory row maps to an
existing test.
*Accepted 2026-10-29: the deliberate break (#48, closed unmerged) failed
`unit` and `inventory` in run 40804919784 and `mergeStateStatus` was
BLOCKED; clean PRs #46 and #47 passed all four checks with no manual
step; the inventory job passes, so every row maps to an existing test.*

## Phase 3.5 — Ingestion follow-ons (≈2 evenings)

Settled before Phase 4 so the dbt models are built on the final grain.

- [x] Item-level tags: a caption like "this one was for <person>" tags
      that line only; whole-message context still tags every line.
      Line-only tags get a line table; header tags stay whole-transaction
      (migration 0012 + DATA_MODEL.md).
- [x] Duplicate warning: the preview flags a likely duplicate (same
      type and amount within 3 days, or the same Telegram photo
      `file_unique_id`). Covers expenses, income (same source too) and
      transfers. Warning only — Confirm stays.
- [x] Merchant commands in Telegram: add and delete a merchant from the
      phone.

**Done when:** a receipt whose caption tags one item writes that tag on
that line only; re-sending a confirmed receipt shows the duplicate
warning; a merchant added from Telegram is used by the next extraction,
and a deleted one is not.

## Phase 4 — Semantic layer (≈2 evenings)

- [ ] dbt project: staging models + marts (fct_transactions,
      fct_category_month, fct_monthly_summary)
- [ ] docs/SEMANTIC_LAYER.md: canonical metric definitions (discretionary
      spend, savings rate, needs/wants ratio, fixed base burn)
- [ ] GitHub Action: nightly `dbt build` + tests (not_null, accepted_values,
      relationships)
- [ ] MetricFlow (local `mf` CLI, dbt-core): semantic models + metrics in
      YAML are the executable form of SEMANTIC_LAYER.md. Grafana still
      reads marts (the hosted Semantic Layer APIs are dbt Cloud only), so
      one test compares `mf query` against the marts.

**Done when:** `dbt build` is green in CI, marts match hand-written SQL for
one sample month, and `mf query` matches the marts for every metric in
SEMANTIC_LAYER.md.

## Phase 4.5 — Proactive nudges (≈2–3 evenings)

The bot speaks first. A separate scheduled Lambda (EventBridge
Scheduler, free tier), not a new path in the webhook handler.

- [ ] Recurring-expense reminders: a declared list of recurring
      expenses; one Telegram nudge before the expected date and one
      after it only if nothing matching was logged.
- [ ] Merchant recommendations: unmatched merchant names counted from
      confirmed transactions (a dbt model, not an LLM); past a frequency
      threshold the bot offers to track it. Accept → insert the merchant
      and backfill `merchant_id` on past matching transactions.

**Done when:** a declared recurring expense produces the before-nudge and,
when it goes unlogged, the after-nudge; a frequent untracked merchant gets
a recommendation, and accepting it creates the merchant and backfills its
past transactions.

## Phase 5 — Dashboards (≈1–2 evenings)

- [ ] Grafana Cloud stack + Postgres data source (read-only role) via
      Terraform; dashboards as code (grafana provider) where practical
- [ ] Rebuild the four Notion views: cumulative monthly spend (ex-rent,
      ex-externally-funded), fixed-expenses donut, most-expensive-wants bar,
      per-day line
- [ ] One new view Notion couldn't do well: month-over-month category drift

**Done when:** the Notion database is no longer needed day-to-day.

## Phase 6 — Analytics agent (≈2 evenings)

- [ ] `.mcp.json`: Postgres MCP server with the read-only role
- [ ] `.claude/agents/`: data-analyst, sql-runner, spend-coach subagents
- [ ] Bucket-classifier subagent: same `docs/BUCKET_RULES.local.md` rules as
      ingest, for backfill / explain / owner-requested reclassify. Ingest
      already assigns buckets on Confirm; this agent does not silently
      overwrite confirmed values
- [ ] Test battery: 10 real questions ("how much did I spend on eating out
      last month vs my 3-month average?") answered correctly against marts

**Done when:** a fresh `claude` session in the repo answers all 10 questions
with numbers matching the dashboards.

## Phase 7 — Open-source polish (ongoing)

- [ ] README with architecture diagram + "deploy your own" guide
      (`terraform apply` + manual steps list: BotFather, Gemini key, secrets)
- [ ] Secrets audit (git history clean), example `.env.example`
- [ ] Cost check: one full month of AWS billing confirms the ingestion side is
      under $0.10 — record the actual figure in DECISIONS.md
- [ ] Evidence.dev static report site on S3 + CloudFront

## Parked (maybe)

Not scheduled. Revisit only when the need is felt in daily use.

- Several receipts in one send (Telegram album). Each photo arrives as
  its own webhook update and a single album caption is attached to one
  photo, so it needs a short buffer (e.g. an SQS delay queue) and one
  Gemini call over all images and captions. Spike Telegram's album
  delivery to the Function URL before designing it.
