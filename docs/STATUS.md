# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-08-17
**Current phase:** Phase 3 — Gemini extraction (see [ROADMAP.md](ROADMAP.md))

## Phase progress

- [x] Planning: architecture, roadmap, and agent context written (2026-07-12)
- [x] Phase 0 — Repo on GitHub, accounts created, MIT license, README (2026-08-10)
- [x] Phase 1 — Supabase project, schema migrations, Notion history import (2026-08-13)
- [x] Taxonomy tweak — Hygiene + Beauty → Personal care (Health and wellness); buckets untouched (2026-08-13)
- [x] Phase 2 — Telegram bot walking skeleton (text only, no LLM) (2026-08-17)
- [ ] Phase 3 — Gemini extraction (text → photo → voice) — **3a on main, Actions deploy green 2026-08-17**
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

Phase 2 complete (2026-08-17): `finflow-ingest` Lambda + Function URL in
`ca-central-1`; SSM shells for bot token, webhook secret, chat allowlist, and
pooler DB URL (values out of band); GitHub OIDC deploy role + Actions workflow
(`Deploy ingest Lambda` on push to `main`). Ingest handler: text quick-log
regex → `ingestions` pending → Telegram Confirm/Discard; Confirm writes
`transactions` + one `transaction_items` line (Phase 2 placeholder: Other
personal / wants). Webhook registered; phone smoke test passed (2026-08-17:
`12.50 lunch chipotle` confirmed in Postgres). OIDC trust policy updated for
GitHub immutable repo-id `sub` claims (DECISIONS.md 2026-08-17).

Phase 3a complete (2026-08-17): all text through Gemini `gemini-3.6-flash`
(free); extractor then bucket specialist; full preview + cents/taxonomy
checks; Confirm writes classified lines. Lambda timeout 30s. SSM:
`/finflow/gemini/api-key`, `/finflow/bucket-rules` (Advanced). Phone smoke
test: `12.50 lunch chipotle` → Takeout / Quick Service / wants (not Other
personal); Chipotle not in merchant lookup so `merchant_id` null as designed.
Photos still reply "next slice". Merged as #5; `Deploy ingest Lambda` on
`main` passed (run 32088245837), so Actions owns the zip.

## Next concrete step

Phase 3b, first slice: Terraform S3 receipts bucket (Block Public Access,
default encryption, Glacier IR at 1 year) + `s3:PutObject` on the Lambda
role. Then receipt photos.

## Open questions

- Whether `merchants.aliases` is seeded by hand or learned from extractions
  over time.
- Grafana Cloud free tier's connection limits against a Supabase free project
  that pauses on inactivity — verify before building Phase 5 dashboards on it.

## Known risks

- Supabase free projects pause after ~1 week of inactivity. Daily logging plus
  the nightly dbt Action should keep it warm; confirm this empirically in
  Phase 4 rather than assuming it.
- Gemini free-tier quotas and model names change. Pinned to `gemini-3.6-flash`
  (DECISIONS.md 2026-08-17); `gemini-2.5-flash` rejected new keys with HTTP 404.
- AWS fails open on cost; keep the Phase 0 `Project=finflow` budget active and
  activate the `Project` cost allocation tag in Billing when it appears.
- One Advanced SSM parameter is $0.05/month (`/finflow/bucket-rules`).
