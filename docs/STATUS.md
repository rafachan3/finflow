# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-08-13
**Current phase:** Phase 2 — Telegram walking skeleton (see [ROADMAP.md](ROADMAP.md))

## Phase progress

- [x] Planning: architecture, roadmap, and agent context written (2026-07-12)
- [x] Phase 0 — Repo on GitHub, accounts created, MIT license, README (2026-08-10)
- [x] Phase 1 — Supabase project, schema migrations, Notion history import (2026-08-13)
- [x] Taxonomy tweak — Hygiene + Beauty → Personal care (Health and wellness); buckets untouched (2026-08-13)
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
with pinned providers plus a `$1/month` budget filtered to `Project=finflow`.

Phase 1 complete (2026-08-13): data model v2 — header/lines schema with
item-level classification, taxonomy v2 in [TAXONOMY.md](TAXONOMY.md),
public-template/personal-overlay seed split (see DECISIONS.md 2026-08-13
entries). Git history rewritten and force-pushed to remove personal
references. Supabase project provisioned via Terraform (`ca-central-1`),
database password rotated out of band. Migrations 0001–0004 (schema, generic
taxonomy seed, read-only role, accounts.kind check) applied via
`supabase db push`. Personal seed overlay and the Notion import applied
through the pooler: 332 transactions (317 expense / 12 income / 3 transfer,
2026-06-01 → 2026-08-12). Production checks pass: counts match the rehearsed
reconciliation, zero expenses without lines, zero line-sum mismatches. Owner
spot-checked 10 random production rows against Notion — all matched.
Read-only role password set out of band. The import tooling remains
untracked (`scripts/import/`, gitignored).

Taxonomy merge (2026-08-13, migration 0005): Hygiene and Beauty collapsed into
**Personal care** under Health and wellness. `transaction_items.bucket` left
unchanged. Contract updated in [TAXONOMY.md](TAXONOMY.md); personal bucket
guide updated in untracked `docs/BUCKET_RULES.local.md`. Notion not yet
updated.

## Next concrete step

Apply migration 0005 with `supabase db push`, then verify Personal care line
counts and untouched buckets. After that: Phase 2 — Telegram walking skeleton
(text only, no LLM).

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
