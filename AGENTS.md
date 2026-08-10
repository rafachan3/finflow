# FinFlow

Self-hosted personal finance pipeline. Telegram bot (receipt photos, voice
notes, text) → LLM extraction → Postgres → dbt semantic layer → dashboards +
an analytics agent. Replaces a Notion expense tracker.

Public repo, MIT. Built as a systems-design exercise as much as a tool.

## Read this first

Before doing any work, read **[docs/STATUS.md](docs/STATUS.md)** — it holds the
current phase, what is done, what is next, and open questions. It is the file
that lets a fresh session pick up where the last one stopped. If you finish
something, update it before you finish your turn.

## Hard constraints

1. **Total cost < $1/month.** Every component runs on a durable free tier.
   Flag explicitly before proposing anything paid.
2. **No paid API in the ingestion path.** Extraction uses Gemini's free tier.
   The Claude agent layer is fine — it rides an existing subscription.
3. **Nothing is written without human confirmation.** The bot replies with the
   parsed transaction and Confirm / Edit / Discard buttons.
4. **Money is `numeric(12,2)`.** Never float. Currency is CAD.
5. **This repo is public.** No tokens, chat IDs, database URLs, or personal
   identifiers in tracked files. Secrets live in SSM Parameter Store, GitHub
   Actions secrets, or `.env` — never in Terraform variables or state.
6. **Low friction wins.** Input priority is photos → voice → text. A change
   that adds a step to logging an expense is a regression.

## Stack

| Layer | Tool | Cost |
|---|---|---|
| Ingestion bot | Telegram Bot API + AWS Lambda + Function URL (TypeScript) | $0 (perpetual free tier) |
| Extraction | Gemini Flash free tier (native image + audio input) | $0 |
| Database | Supabase Postgres | $0 |
| Receipt images | AWS S3 (private, Glacier IR after 1yr) | ~$0.05/mo |
| Semantic layer | dbt-core, run via GitHub Actions cron | $0 |
| Dashboards | Grafana Cloud free tier; Supabase SQL editor for ad-hoc | $0 |
| Analytics agent | Claude Code: subagents in `.claude/agents/` + Postgres MCP | $0 marginal |
| Infrastructure | Terraform in `infra/` (aws, supabase, grafana providers) | $0 |

AWS is the only component that bills rather than failing closed. A
`aws_budgets_budget` alarm at $1/month is a required resource, and Lambda's
free tier (1M req/month) is perpetual, not a 12-month trial.

## Where knowledge lives

| File | Holds | Update when |
|---|---|---|
| `docs/STATUS.md` | Current phase, done/next, open questions | Every session that lands work |
| `docs/ROADMAP.md` | The 7 phases and their acceptance checks | Scope changes |
| `docs/ARCHITECTURE.md` | System diagram, component rationale, security | A component choice changes |
| `docs/DATA_MODEL.md` | Full DDL, Notion → Postgres mapping | Schema changes (with the migration) |
| `docs/SEMANTIC_LAYER.md` | Canonical metric definitions *(created in Phase 4)* | A metric is added or redefined |
| `docs/DECISIONS.md` | Dated log of decisions and what they ruled out | A decision is made or reversed |

Keep this file short. New long-form knowledge goes in `docs/` and gets a row in
the table above — not appended here.

## Conventions

- SQL migrations live in `supabase/migrations/`, plain SQL, numbered, and are
  never edited after merge — add a new migration instead.
- `docs/DATA_MODEL.md` and the migrations must agree. Change both in one commit.
- dbt models must match `docs/SEMANTIC_LAYER.md`. That file is the contract;
  if a model disagrees with it, the model is wrong.
- Work one roadmap phase at a time. Do not start a phase until the previous
  phase's acceptance check in `docs/ROADMAP.md` actually passes.
- The ingestion Lambda stays stateless: validate → persist raw → archive media
  → extract → reply. All state lives in Postgres.
- Terraform in `infra/` provisions infrastructure only. Database schema belongs
  to `supabase/migrations/`; secret values are written to Parameter Store out
  of band and referenced, never passed as Terraform variables.
- Terraform owns the Lambda function, role, and URL — **not its code**. Code
  ships via `update-function-code` from CI, and the function carries
  `ignore_changes = [filename, source_code_hash]`. Never remove that block or
  add the real bundle to Terraform: both make `terraform apply` roll the
  deployed function back to the bootstrap stub.

## Verification

There is no test suite yet. Until there is, "done" means the acceptance check
written in `docs/ROADMAP.md` for that phase has been run and passed. Say which
check you ran and what it output. Do not report a phase complete otherwise.
