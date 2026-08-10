# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-08-10
**Current phase:** Phase 1 — Database foundation (see [ROADMAP.md](ROADMAP.md))

## Phase progress

- [x] Planning: architecture, roadmap, and agent context written (2026-07-12)
- [x] Phase 0 — Repo on GitHub, accounts created, MIT license, README (2026-08-10)
- [ ] Phase 1 — Supabase project, schema migrations, Notion history import
- [ ] Phase 2 — Telegram bot walking skeleton (text only, no LLM)
- [ ] Phase 3 — Gemini extraction (text → photo → voice)
- [ ] Phase 4 — dbt semantic layer
- [ ] Phase 5 — Grafana dashboards
- [ ] Phase 6 — Claude analytics agent (subagents + Postgres MCP)
- [ ] Phase 7 — Open-source polish

## What exists right now

Phase 0 complete: public GitHub repo, MIT `LICENSE`, root `README.md`, accounts
(AWS, Supabase, Grafana Cloud, Google AI Studio, Telegram bot) with secrets in
a password manager, AWS hygiene (`ca-central-1`, non-root admin), and `infra/`
with pinned providers plus a `$1/month` budget filtered to `Project=finflow`
(plus bootstrap SSM parameter). No Supabase project/schema, migrations, or
deployed Lambda yet.

## Next concrete step

Phase 1: provision the Supabase project via Terraform (`infra/`), link the
Supabase CLI, add migration 0001 from [DATA_MODEL.md](DATA_MODEL.md), seed
taxonomy data, import Notion history, and create a read-only Postgres role for
future MCP/Grafana use.

## Open questions

- Notion export path for the history import: MCP pull vs. manual CSV export.
  Decide during Phase 1.
- Whether `merchants.aliases` is seeded by hand from the Notion tag list or
  learned from extractions over time.
- Grafana Cloud free tier's connection limits against a Supabase free project
  that pauses on inactivity — verify before building Phase 5 dashboards on it.

## Known risks

- Supabase free projects pause after ~1 week of inactivity. Daily logging plus
  the nightly dbt Action should keep it warm; confirm this empirically in
  Phase 4 rather than assuming it.
- Gemini free-tier quotas and model names change. Pin the model in code and
  record the version in `DECISIONS.md` when chosen.
- AWS fails open on cost; keep the Phase 0 `Project=finflow` budget active and
  activate the `Project` cost allocation tag in Billing when it appears.
