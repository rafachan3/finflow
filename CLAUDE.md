# FinFlow — Personal Finance Pipeline

Self-hosted, near-zero-cost personal finance system. Replaces a Notion-based
expense tracker with a proper data pipeline: Telegram bot for frictionless
logging (receipt photos and voice notes first, text second) → LLM extraction →
Postgres → dbt semantic layer → dashboards + an analytics agent.

**Owner:** Rafael ([email redacted]). Personal project, also a systems-design
learning exercise. Open source on GitHub.

## Hard constraints

- **Cost: < $1/month total.** Every component must run on a durable free tier.
  Never propose paid infrastructure without flagging it explicitly.
- Currency is CAD; user is in Montreal (Bixi, STM metro, depanneurs).
- Logging priority: 1) receipt photos, 2) voice notes, 3) plain text.
  Low friction is the whole point of the Telegram entry path.

## Stack (decided — see docs/ARCHITECTURE.md for rationale)

| Layer | Tool | Cost |
|---|---|---|
| Ingestion bot | Telegram Bot API + Cloudflare Workers (TypeScript, webhook) | $0 |
| Extraction LLM | Gemini Flash free tier (native image + audio input) | $0 |
| Database | Supabase Postgres (+ Supabase Storage for receipt images) | $0 |
| Transform / semantic layer | dbt-core, run via GitHub Actions cron | $0 |
| Dashboards | Grafana Cloud free tier + Supabase SQL editor for ad-hoc SQL | $0 |
| Analytics agent | Claude Code in this repo: subagents in `.claude/agents/` + Postgres MCP server | $0 marginal (existing subscription) |

The analytics agent uses Claude (already paid via subscription); the ingestion
extraction uses Gemini's free tier because the API budget is $0. Don't "simplify"
by putting a paid API in the ingestion path.

## Data model in one paragraph

Migrated from the Notion "📒 Transactions" DB (Notion database id
`27fb728f3fbe800f890dc285438d94b0`, data source
`collection://27fb728f-3fbe-80c0-a4ff-000b0d9a4a02`). Transactions are
`income | expense | transfer` ("Financial Future" in Notion = transfer to
savings). Two-level taxonomy: 10 categories → 37 subcategories, with
`bucket` (needs/wants) and `cadence` (fixed/variable) stored as attributes of
the subcategory (they were Notion formulas). Merchants are first-class
(Notion mixed them into tags). Tags remain for context (Travel, Social,
Avoidable…). `funded_by` covers the "Paid by family?" flag. Every Telegram message
lands in an `ingestions` audit table before becoming a confirmed transaction.
Full DDL: docs/ARCHITECTURE.md.

## Key decisions log

- 2026-07-12: Project planned. Supabase over Neon (Storage bucket for receipt
  images + Studio SQL editor were the tiebreakers). Cloudflare Workers over a
  VPS (webhook model, zero maintenance). Gemini over Claude for extraction
  (free tier; multimodal). Amounts stored as `numeric(12,2)`, never float.
- Human-in-the-loop: the bot always replies with the parsed transaction and
  inline Confirm / Edit / Discard buttons. Nothing is committed unconfirmed.

## Current status

- [x] Plan + architecture + roadmap written (2026-07-12)
- [ ] Phase 1: Supabase project + schema migrations + Notion history import
- [ ] Phase 2: Telegram bot walking skeleton (text-only, no LLM)
- [ ] Phase 3: Gemini extraction (text → photo → voice)
- [ ] Phase 4: dbt semantic layer
- [ ] Phase 5: Grafana dashboards
- [ ] Phase 6: Claude analytics agent (subagents + Postgres MCP)

Work phase by phase (docs/ROADMAP.md); update the status list above and the
decisions log as things land.

## Conventions

- SQL migrations live in `supabase/migrations/`, plain SQL, never edited after merge.
- Secrets only in Worker secrets / GitHub Actions secrets / `.env` (gitignored).
  This repo is public — never commit tokens, chat IDs, or Supabase keys.
- Metric definitions live in `docs/SEMANTIC_LAYER.md` and dbt models must match it.
