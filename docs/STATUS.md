# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-08-28
**Current phase:** Phase 3 — Gemini extraction (see [ROADMAP.md](ROADMAP.md))

## Phase progress

- [x] Planning: architecture, roadmap, and agent context written (2026-07-12)
- [x] Phase 0 — Repo on GitHub, accounts created, MIT license, README (2026-08-10)
- [x] Phase 1 — Supabase project, schema migrations, Notion history import (2026-08-13)
- [x] Taxonomy tweak — Hygiene + Beauty → Personal care (Health and wellness); buckets untouched (2026-08-13)
- [x] Phase 2 — Telegram bot walking skeleton (text only, no LLM) (2026-08-17)
- [ ] Phase 3 — Gemini extraction (text → photo → voice) — **3a + 3b phone-tested; voice (3c) next**
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
checks; Confirm writes classified lines. SSM: `/finflow/gemini/api-key`,
`/finflow/bucket-rules` (Advanced). Phone smoke test: `12.50 lunch chipotle`
→ Takeout / Quick Service / wants (not Other personal); Chipotle not in
merchant lookup so `merchant_id` null as designed. Merged as #5;
`Deploy ingest Lambda` on `main` passed (run 32088245837), so Actions owns
the zip.

Date HITL (2026-08-18, #7): text with no date → today + warning; Fix date →
`awaiting_date`; next text is the date (or “still waiting” if it is not a
date). Phone-tested: default-today Chipotle, Fix date → yesterday wrote
`occurred_on` 2026-08-17, `12.50 coffee` while waiting did not create a
transaction. Extraction `meta` hashes stored per row. Migration 0006
applied. Category/amount Edit stays later.

S3 receipts bucket applied (2026-08-20, #9): `finflow-receipts-<account_id>`
in `ca-central-1`, Block Public Access, SSE-S3, Glacier IR at 1 year, ingest
role `s3:PutObject` only.

Receipt photos merged as #10 (2026-08-27): camera/gallery `message.photo`
only. Largest size → Telegram `getFile` → Gemini vision (image + caption)
→ photo date policy → UUID → S3 `{id}.jpg`/`.png` → `ingestions` with
`source=photo` and `media_path`. Lambda timeout 60s; env
`RECEIPTS_BUCKET`. `Deploy ingest Lambda` on `main` passed (run
33138236837). Dateless receipts persist without Confirm (Fix date /
Discard stay). A photo while `awaiting_date` is still waiting, not a new
expense. Voice and PDF/document remain later.

First photo after merge failed with no Telegram reply: the Supabase
project was `INACTIVE` (paused). Pooler error
`tenant/user postgres.<ref> not found` at `findAwaitingDateIngestion`;
the handler returns 500 without sending a message. After restore, a dated grocery receipt photo extracted with correct
totals, taxonomy, and buckets. Confirm (2026-08-28) wrote the
`transactions` header and `transaction_items` lines. `ingestions`
`source=photo`, `status=confirmed`, `media_path` = `{id}.jpg`; that
object is in the receipts bucket. Merchant was not in lookup
(`merchant_id` null). Receipt department labels are not stored.

English item descriptions merged as #12: header and line names are
ordinary English; brand names stay. The confirmed photo used that
prompt (an earlier discarded send had kept the receipt language).

Dateless-receipt persist (no Confirm) is not yet phone-tested.

## Next concrete step

Phase 3c: voice notes (`message.voice` → Gemini audio → same confirm
loop). Optional leftover smoke: a receipt with no printed or caption
date persists without Confirm.

## Open questions

- Whether `merchants.aliases` is seeded by hand or learned from extractions
  over time.
- Grafana Cloud free tier's connection limits against a Supabase free project
  that pauses on inactivity — verify before building Phase 5 dashboards on it.

## Known risks

- Supabase free projects pause after ~1 week of inactivity. Hit empirically
  2026-08-27 (`INACTIVE`; bot silent). Daily logging plus the nightly dbt
  Action should keep it warm once Phase 4 exists; until then, restore from
  the dashboard after a gap.
- Gemini free-tier quotas and model names change. Pinned to `gemini-3.6-flash`
  (DECISIONS.md 2026-08-17); `gemini-2.5-flash` rejected new keys with HTTP 404.
- AWS fails open on cost; keep the Phase 0 `Project=finflow` budget active and
  activate the `Project` cost allocation tag in Billing when it appears.
- One Advanced SSM parameter is $0.05/month (`/finflow/bucket-rules`).
