# Roadmap

Each phase ends with something that works end-to-end. Don't start a phase
until the previous one's acceptance check passes. Update
[STATUS.md](STATUS.md) as phases land, and append to
[DECISIONS.md](DECISIONS.md) when a phase settles an open question.

## Phase 0 — Repo & accounts (≈1 evening)

- [ ] `git init`, push to a public GitHub repo
- [ ] Create accounts: Supabase, Cloudflare, Grafana Cloud, Google AI Studio
      (Gemini API key), Telegram bot via @BotFather
- [ ] Add MIT license, README stub pointing at docs/

**Done when:** repo is on GitHub and all API keys exist (stored in a password
manager, none committed).

## Phase 1 — Database foundation (≈1–2 evenings)

- [ ] Supabase project + Supabase CLI linked (`supabase/migrations/`)
- [ ] Migration 0001: full schema from docs/DATA_MODEL.md
- [ ] Seed migration: categories, subcategories (with bucket/cadence mapping
      replicating the Notion formulas), tags, income sources, accounts,
      merchants (from Notion tag list: Costco, Amazon, Dollarama, ...)
- [ ] One-off import script: Notion → CSV → `transactions` (Claude can pull
      the Notion data via MCP and generate the CSV)
- [ ] Read-only Postgres role for future MCP/Grafana use

**Done when:** `select count(*) from transactions` matches the Notion row
count and a spot-check of 10 random rows matches Notion exactly.

## Phase 2 — Telegram walking skeleton, no LLM (≈2 evenings)

- [ ] Cloudflare Worker + webhook registered with secret token
- [ ] Chat-ID allowlist (owner only), chat ID stored as a Worker secret
- [ ] Text-only quick-log format: `12.50 lunch chipotle` → parsed with a dumb
      regex → `ingestions` row → reply with Confirm / Discard buttons
- [ ] Confirm button → transaction inserted; Discard → status flip
- [ ] Idempotency verified (replay the same update, no duplicate)

**Done when:** a text message becomes a confirmed row in Postgres from your
phone, and the bot survives a webhook retry without duplicating.

*Why before the LLM: the confirm loop, webhook plumbing, and DB writes are the
skeleton everything else hangs on. Ship the smallest loop first.*

## Phase 3 — LLM extraction (≈2–3 evenings)

- [ ] 3a. Natural-language text via Gemini structured output
      (taxonomy injected into the prompt from the DB)
- [ ] 3b. Receipt photos: Telegram file API → Gemini vision → itemized total,
      merchant, date; image archived to Supabase Storage
- [ ] 3c. Voice notes: Telegram OGG → Gemini audio input → same pipeline
- [ ] Edit flow: reply buttons let you fix category/amount before confirm
- [ ] Log Gemini token usage per request into `ingestions.extraction`

**Done when:** photo of a real receipt and a voice note each produce a correct
confirmed transaction with ≤1 manual correction on average.

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

- [ ] Grafana Cloud → Supabase (read-only role)
- [ ] Rebuild the four Notion views: cumulative monthly spend (ex-rent,
      ex-externally-funded), fixed-expenses donut, most-expensive-wants bar, per-day line
- [ ] One new view Notion couldn't do well: month-over-month category drift

**Done when:** the Notion database is no longer needed day-to-day.

## Phase 6 — Analytics agent (≈2 evenings)

- [ ] `.mcp.json`: Postgres MCP server with the read-only role
- [ ] `.claude/agents/`: data-analyst, sql-runner, spend-coach subagents
- [ ] Test battery: 10 real questions ("how much did I spend on eating out
      last month vs my 3-month average?") answered correctly against marts

**Done when:** a fresh `claude` session in the repo answers all 10 questions
with numbers matching the dashboards.

## Phase 7 — Open-source polish (ongoing)

- [ ] README with architecture diagram + "deploy your own" guide
- [ ] Secrets audit (git history clean), example `.env.example`
- [ ] Optional: Evidence.dev static report site on Cloudflare Pages
