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
- [ ] 3c. Voice notes: Telegram OGG → Gemini audio input → same pipeline
      *(implemented; leave unchecked until Confirm + S3 `.ogg`)*
- [x] Date HITL: text with no date defaults to today (warning); photo with
      no date blocks Confirm; Fix date → `ingestions.status = awaiting_date`
      *(phone-tested 2026-08-18)*
- [ ] Funding source is expense-only: `funding_source_id` nullable;
      CHECK expense ⇒ not null, income/transfer ⇒ null. Backfill
      existing income and transfer rows to null. Confirm preview
      shows Funded by only on expenses. After 3c phone test.
      Migration and DATA_MODEL.md in the same change. Transfers do
      not get a “who funded this move” rule unless we add one later.
- [ ] Edit flow: reply buttons let you fix category/amount before confirm
      (date-only Fix date already shipped)
- [ ] Multi-event message: one text, voice, or photo+caption that
      describes 2+ independent ledger headers → N pending ingestions
      and N Confirm cards. A grocery breakdown (several SKUs) plus an
      unrelated drink or a separate income in the same message is two
      headers: the trip stays one expense with lines; the extra event
      is its own row. After 3c phone test and Edit. A grocery trip
      alone is already one expense with lines on every channel. Until
      then, send separate messages for distinct headers.
- [x] Log Gemini token usage per request into `ingestions.extraction`,
      plus `meta` (model + sha256 of extractor, taxonomy, bucket prompt,
      and rules). No eval mart until Phase 4.

**Done when:** photo of a real receipt and a voice note each produce a correct
confirmed transaction with ≤1 manual correction on average, and the image is
retrievable from S3 at the key recorded in `ingestions.media_path`.

## Phase 4 — Semantic layer (≈2 evenings)

- [ ] dbt project: staging models + marts (fct_transactions,
      fct_category_month, fct_monthly_summary)
- [ ] docs/SEMANTIC_LAYER.md: canonical metric definitions (discretionary
      spend, savings rate, needs/wants ratio, fixed base burn)
- [ ] GitHub Action: nightly `dbt build` + tests (not_null, accepted_values,
      relationships)

**Done when:** `dbt build` is green in CI and marts match hand-written SQL for
one sample month.

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
- [ ] Optional: Evidence.dev static report site on S3 + CloudFront
