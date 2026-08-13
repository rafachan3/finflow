# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-08-13
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

Phase 1 in progress (2026-08-13): data model v2 designed and documented —
header/lines schema with item-level classification, taxonomy v2 in
[TAXONOMY.md](TAXONOMY.md), public-template/personal-overlay seed split (see
DECISIONS.md 2026-08-13 entries). Git history rewritten and force-pushed to
remove personal references. Migrations 0001–0003 (schema, generic taxonomy
seed, read-only role) written and validated against a local Supabase stack
(`supabase db reset`). Notion import built and fully rehearsed locally:
332 transactions (317 expense / 12 income / 3 transfer, June 2026 onward)
reconciled row-by-row against the Notion source — counts, sums, tags,
venues, and merchants all match.

## Next concrete step

Provision the Supabase project (`infra/supabase.tf` is written; needs
`SUPABASE_ACCESS_TOKEN` in the environment and `supabase_organization_id`
in `terraform.tfvars`), rotate the database password out of band, then:
`supabase link` + `supabase db push`, apply `supabase/seed.personal.sql`,
run `scripts/import/data/import.sql`, set the read-only role's password,
and re-run the acceptance check against production.

## Open questions

- Whether `merchants.aliases` is seeded by hand or learned from extractions
  over time.
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
