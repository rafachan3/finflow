# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-10-28
**Current phase:** Phase 3.6 — Regression test suite (see [ROADMAP.md](ROADMAP.md))

## Phase progress

- [x] Planning: architecture, roadmap, and agent context written (2026-07-12)
- [x] Phase 0 — Repo on GitHub, accounts created, MIT license, README (2026-08-10)
- [x] Phase 1 — Supabase project, schema migrations, Notion history import (2026-08-13)
- [x] Taxonomy tweak — Hygiene + Beauty → Personal care (Health and wellness); buckets untouched (2026-08-13)
- [x] Phase 2 — Telegram bot walking skeleton (text only, no LLM) (2026-08-17)
- [x] Phase 3 — Gemini extraction (text → photo → voice) — **3a + 3b + 3c phone-tested; funding source applied; Edit phone-tested; context notes phone-tested; multi-event accepted by the Phase 3.6 journeys** (2026-10-28; the S3 key prefix stays an optional leftover)
- [ ] Phase 3.6 — Regression test suite — **in progress: integration tests (#32), chat journeys (#33), live eval (#37) and the inventory check with a coverage floor done**
- [ ] Phase 3.5 — Ingestion follow-ons (item tags, duplicate warning, merchant commands)
- [ ] Phase 4 — dbt semantic layer + MetricFlow
- [ ] Phase 4.5 — Proactive nudges (recurring reminders, merchant recommendations)
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
applied.

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
expense.

Voice notes (3c, #14): `message.voice` only (not `message.audio` or
document). Caption goes to Gemini with the audio. Date policy matches
text: missing date defaults to today with a warning; Confirm stays.
After checks, UUID → S3 `{id}.ogg` → `ingestions` `source=voice`.
A voice note while `awaiting_date` is still waiting.

Phone-tested 2026-08-29: one-header voice → Confirm wrote the ledger
row; `ingestions` `source=voice`, `status=confirmed`, `media_path` =
`{id}.ogg`, `transaction_id` set; that object is in the receipts
bucket. Dateless voice showed the today warning with Confirm still
offered. A voice note after Fix date was still waiting, not a new
expense.

Expense-only `funding_source_id` (#17, applied 2026-08-30): nullable;
CHECK expense ⇒ not null, income/transfer ⇒ null. Migration 0007
applied after `Deploy ingest Lambda`; existing income/transfer rows
backfilled to `NULL`. Confirm writes `NULL` for income/transfer.
Preview shows Funded by only on expenses. Gemini `funded_by` is
nullable; #18 defaults an omitted expense funder to `self`.
Phone-tested: expense preview `Funded by: self` and Confirm writes a
funding source; income and transfer previews omit Funded by and
Confirm writes `funding_source_id` NULL. CHECKs and backfill counts
match in production.

Edit HITL (merged as #19, 2026-09-08): Confirm card gains **Edit**
(`e:<uuid>`). Confirm / Discard on the first row, Fix date / Edit on
the second. Dateless photos still omit Confirm; Edit stays. Edit sets
`ingestions.status` to `awaiting_edit` (migration 0008, applied). Next
text is a freeform correction; Gemini patches the stored extraction
(no photo/voice re-download) then the bucket specialist. Checks fail
→ stay waiting. Checks pass → `pending` and a new preview. A photo or
voice while waiting is still waiting. Discard works from
`awaiting_edit`. One outstanding wait at a time (`awaiting_date` or
`awaiting_edit`). Phone-tested 2026-09-08: amount, category, and a
photo while still waiting all held.

Scope set 2026-10-12 (DECISIONS.md): context notes and multi-event
close Phase 3; new Phases 3.5 and 4.5; Telegram albums parked. The
deploy workflow now also runs tests + bundle on PRs (AWS steps
push-only). A personal name in a test fixture was replaced.

Context notes (merged as #23, deployed 2026-10-12): Gemini extracts `notes`, the owner's
reason or circumstance in their words (translated to English), from
the message, caption, or voice and never from receipt text. The card
shows `Note: …` under the description; Confirm writes
`transactions.notes` (column since 0001, no migration). Edit can
change it. Rows extracted before notes write NULL. First `db.ts`
test (pg mock on the transactions insert). Phone-tested 2026-10-12:
text with a reason and voice saved the owner's words; text and a
receipt without a reason saved NULL (no note invented from receipt
text); a caption reason became the note; a note added through Edit
was saved. Notes are verbatim, typos included.

Gemini overload (2026-10-12): every logged error since 2026-09-30
(8 in ~28 interactions) was `Gemini HTTP 503` "high demand" from
`gemini-3.6-flash`; one attempt meant one 503 reached the owner as
"Couldn't read that receipt". `generateJson` now retries 500/503/504
twice (2s, 5s) and logs `Gemini HTTP <status>; retry <n>`; 429 and
other 4xx are not retried. If a 5xx still survives, the reply says
Gemini is overloaded instead of blaming the input (merged as #24).
The first receipt after that deploy still failed: three 3.6 attempts
over ~15s, all 503. A probe of five models showed 3.7/3.8 slow or
overloaded and `gemini-3.5-flash` fast and available, so retries now
move to the fallback: 3.6, then 3.5 after 2s and 5s. `meta.model`
records the model that answered the extraction; `meta.bucket_model`
the bucket step's. Log line: `Gemini HTTP <status> on <model>; retry
<n> on <model>`. DECISIONS.md 2026-10-12. Merged as #25.

The next two receipts after #25 still failed: 3.5 was shedding too.
Replaying the bot's real 153 KB receipt request showed both Flash
models returning 503 (and 3.5 a 429) while tiny text requests passed,
and `gemini-3.5-flash-lite` returning correct totals in ~1.7s with
wobbly categories. Third attempt is now Lite; 429 moves to the next
model (quota is per model). Cards Lite produced show "! read by a
lighter model while Gemini was busy — check categories and buckets".
Owner decision: if receipts still fail after this, move ingestion to
the paid tier. Merged as #26; the receipt that had failed went
through after deploy.

PDF/document and S3 key prefixes remain later. Media still lands at
the bucket root as `{id}.{ext}`; source/month prefixes are a leftover.

First photo after merge failed with no Telegram reply: the Supabase
project was `INACTIVE` (paused). Pooler error
`tenant/user postgres.<ref> not found` at `findAwaitingIngestion`;
the handler returns 500 without sending a message. After restore, a
dated grocery receipt photo extracted with correct totals, taxonomy,
and buckets. Confirm (2026-08-28) wrote the `transactions` header and
`transaction_items` lines. `ingestions` `source=photo`,
`status=confirmed`, `media_path` = `{id}.jpg`; that object is in the
receipts bucket. Merchant was not in lookup (`merchant_id` null).
Receipt department labels are not stored.

English item descriptions merged as #12: header and line names are
ordinary English; brand names stay. The confirmed photo used that
prompt (an earlier discarded send had kept the receipt language).

Dateless-receipt persist (no Confirm) is not yet phone-tested.

Multi-event (2026-10-12, branch `feat/multi-event`; migration 0009
applied and verified): one text, photo, or voice message can become
several purchases, each its own `ingestions` row and card labelled
"(i of n)", confirmed independently; no "Confirm all". Split by place;
the same or no place stays one expense with lines; income and
transfers are always separate. Gemini returns `{events}` (split rule in
the text, photo, and voice prompts only); one bucket call covers all
lines; usage is stored on the first saved event. `event_index` default
0, unique `(telegram_update_id, event_index)`; the 66 existing rows are
event 0. A per-update advisory lock stops a retry from saving a second
set (DECISIONS.md 2026-10-12). Only one card waits for a date or
correction at a time: Fix date or Edit on another card gets "Finish the
waiting card first." A card send that fails after the rows are saved is
logged and the other cards still go out, with no false "Couldn't
parse" reply.

Regression suite (Phase 3.6, 2026-10-28; DECISIONS.md): `lambda/tests/`
splits into a `unit` vitest project (mocks, no database) and an
`integration` project that recreates a `finflow_test` database on a
local `postgres:17`, applies every migration plus
`seed.personal.example.sql`, and runs every `db.ts` path against real
SQL, including two connections racing on one update. The harness
refuses any host but `localhost`. `.github/workflows/ci.yml` runs both
on every PR; the deploy workflow runs only on main.

Journeys (`lambda/tests/journeys/`) run the real handler against that
database. MSW fakes Telegram and Gemini, and any other outbound request
fails the test. `aws-sdk-client-mock` fakes S3, and a `chat` driver sends
messages and taps buttons the way the owner does. Gemini's answers come
from `lambda/tests/golden/*.json`; recorded lines without a bucket parse
as `wants`. The journeys cover every row of the retired phone-test table plus
everyday logging, Edit, owner-only access and failures.

Live eval (`lambda/eval/`, `npm run eval`): every golden case goes through
the production `extractFromText` / `extractFromPhoto` / `extractFromVoice`
/ `patchExtraction` with the taxonomy loaded from the throwaway database,
no bucket rules (the bot's no-rules fallback), and the eval's own key.
Gemini's first answer is checked against the case's `expect`; a miss gets
one retry. Requests start at least 13 s apart, and each response logs its
model and status (a 429 also its `quotaId` and `retryDelay`). When every
model answers 5xx or a per-minute 429 the run waits 2 minutes and tries
again, for at most 20 minutes per run. A per-day 429 takes that model out
of the run and production's chain moves on; the run fails at once only
when every model is out for the day. The job summary tables each case's
answering model.
`--record` rewrites a golden's
`recorded` only when the live answer satisfies `expect`. The CI `eval` job
always reports: with no change to a path in `RELEVANT`
(`lambda/eval/harness.ts`: source, goldens, eval, migrations, example
seed, the integration DB setup, `lambda/package*.json`, `ci.yml`)
since the base commit it passes without calling Gemini; otherwise a
missing secret fails it with one line. Golden media are synthetic: SVG
receipts rendered with `rsvg-convert`, and a macOS `say` clip encoded as
Opus by `afconvert` and wrapped in Ogg by `caf2ogg.py`.

One Gemini request per message (2026-10-28; DECISIONS.md): the
extractor now sets each line's `bucket_why` and `bucket` itself, with
the owner's SSM rules (or the no-rules fallback) after the taxonomy in
its system instruction. The item schema's `propertyOrdering` puts the
reason after the category and the label last. A text, photo, voice or
multi-event message is 1 request instead of 2, and an Edit is 1 instead
of 2. An Edit sends each line's stored bucket and reason back and keeps
them unless the correction changes that line, so "that one is a need"
now works. `meta` drops `bucket_sha256` / `bucket_model` and `usage`
drops `bucket`; older rows keep them. A full eval run is 13 requests,
down from 25. With no rules, the default_bucket hints now reach the
model; before, the bucket call was told to use hints it never got.

Enforcement (Phase 3.6 PR 4, 2026-10-28; DECISIONS.md): `docs/TESTING.md`
maps every bot behaviour to the tests that guard it and
`scripts/check-inventory.mjs` fails a row with no test or a cited title
that does not exist. The `inventory` CI job runs that check and
`npm run test:coverage`, whose floor is lines 90, statements 90, branches
84, functions 98 (measured 90.63 / 90.63 / 84.98 / 98.68). The deploy
workflow now runs after a successful CI run on `main`. Journeys wait out no
real retry delay: `retryWait.sleep` in `gemini.ts` is the test seam.

Needs/wants accuracy check (2026-10-28; TESTING.md): `npm run
eval:buckets` replays a seeded sample of the Notion-imported expenses
(owner-set buckets) through `extractFromText` with the private rules and
prints agreement, per-category confusion, model mix and mismatches. Reads
through `finflow_readonly` only; local only, never in CI.

## Next concrete step

Owner: add `GEMINI_EVAL_API_KEY=<eval key>` to the gitignored `.env` in the
main checkout, then run `npm --prefix lambda run eval:buckets` for a
baseline agreement figure.

Owner phone check of the single call with the real rules: log 3 to 5
real expenses, including one where the rules overrule the subcategory
hint, plus one Edit that says "that one is a need". Check each card's
bucket and reason. If an Edit flips the bucket on a line it did not
touch, add a code guard (DECISIONS.md 2026-10-28).

Owner: create a Google AI Studio project and API key just for the eval
and add it as the `GEMINI_EVAL_API_KEY` Actions secret. Then re-run the
eval PR's `eval` job; it must pass before that PR merges. If a live answer
legitimately differs from a recording, `npm run eval -- --record` with the
key exported refreshes the goldens it satisfies.

Owner: make `unit`, `integration`, `eval` and `inventory` required checks on
`main` (branch protection; not changed by any PR). Then Phase 3.6 PR 5, the
post-deploy smoke step.

Optional leftover: S3 keys `{source}/{yyyy-mm}/{id}.{ext}` in the existing
bucket.

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
  with `gemini-3.5-flash` and `gemini-3.5-flash-lite` as fallbacks (DECISIONS.md
  2026-08-17, 2026-10-12); `gemini-2.5-flash` rejected new keys with HTTP 404.
  A retired fallback 404s, and 404 is not retried: the chain stops there.
- AWS fails open on cost; keep the Phase 0 `Project=finflow` budget active and
  activate the `Project` cost allocation tag in Billing when it appears.
- One Advanced SSM parameter is $0.05/month (`/finflow/bucket-rules`).
- Gemini free tier sheds receipt-sized requests first at peak demand.
  Fallbacks 3.5 then Lite; all three failing still fails the message
  (the owner resends). If that keeps happening, the owner moves
  ingestion to the paid tier (DECISIONS.md 2026-10-12).
  `ingestions.extraction->'meta'->>'model'` shows which model answered.
- All three models ending on 429 replies with the generic "Couldn't
  read…" message, not the overload one: a daily quota would make "send
  it again in a minute" wrong.
- Multi-event gaps: a failed send of card 2 leaves that row pending
  without a card (logged as `card send error`; no reply to the owner); a retried photo/voice still uploads an extra S3 object
  before the insert decides; migration 0009 is forward-only once any
  update has `event_index > 0`.
