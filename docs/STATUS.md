# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-10-31
**Current phase:** Phase 4.5 — Proactive nudges, in progress: PR 1 (schema and detection) merged and migration 0016 applied; PR 2 (`/recurring` menu, add, backfill-verify) merged as #87; PR 3 (the card proposes and links the series) merged as #88; PR 4 (nudge Terraform, `feat/nudge-infra`) in review, apply before PR 5 merges (see [ROADMAP.md](ROADMAP.md) and Next concrete step). Alongside: financial-future metrics PR C (`feat/financial-future-metrics`, migration 0018) in review

## Phase progress

- [x] Planning: architecture, roadmap, and agent context written (2026-07-12)
- [x] Phase 0 — Repo on GitHub, accounts created, MIT license, README (2026-08-10)
- [x] Phase 1 — Supabase project, schema migrations, Notion history import (2026-08-13)
- [x] Taxonomy tweak — Hygiene + Beauty → Personal care (Health and wellness); buckets untouched (2026-08-13)
- [x] Phase 2 — Telegram bot walking skeleton (text only, no LLM) (2026-08-17)
- [x] Phase 3 — Gemini extraction (text → photo → voice) — **3a + 3b + 3c phone-tested; funding source applied; Edit phone-tested; context notes phone-tested; multi-event accepted by the Phase 3.6 journeys** (2026-10-28; S3 key prefix landed 2026-10-29)
- [x] Phase 3.6 — Regression test suite — **accepted 2026-10-29: deliberate-break PR #48 blocked (unit + inventory failed, BLOCKED), clean PRs #46/#47 green, smoke step green on deploy run 40803017809, `main` protected** (2026-10-29)
- [x] Phase 3.5 — Ingestion follow-ons — **accepted 2026-10-29 by the journey tests (no phone test): 25 of 25 passed in `line-tags`, `duplicates` and `merchants`; see Next concrete step** (2026-10-29)
- [x] Phase 4 — dbt semantic layer + MetricFlow — **accepted 2026-10-30: `dbt build`, the hand-written-SQL reconciliation and `mf query` vs the marts green in CI on the fixture (#72-#78) and on production in `dbt-nightly` run 41157900716 (87 of 87 nodes, 14 metrics, 5 months); real-month hand verification deferred** (2026-10-30)
- [ ] Phase 4.5 — Proactive nudges (recurring reminders, merchant recommendations) — **PRs 1-3 of 7 merged (#86 with migration 0016 applied, #87, #88); PR 4 (nudge Terraform) in review** (2026-10-31)
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
was saved. Notes were verbatim, typos included, until #27.

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

PDF/document remain later. New media lands at
`{source}/{yyyy-mm}/{id}.{ext}` (see the S3 key note below); older
objects keep flat `{id}.{ext}` keys.

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
no bucket rules (the bot's no-rules fallback) unless the case names a
ruleset, and the eval's own key.
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

Bucket rule-following is automated instead of phone-checked (2026-10-28;
DECISIONS.md). Four `rules-*` goldens run under
`lambda/tests/golden/bucket-rules.synthetic.md`, a fictional ruleset the
eval sends where production sends `config.bucketRules`. Each lists the
bucket every line must get: a rule overruling the Taxis and rideshares
wants hint, a receipt split between needs and wants, a bill no rule
covers (its needs hint applies), and an Edit that calls one receipt line
a need and keeps the other two. A journey replays that Edit through
Confirm. A full eval run is 18 requests when every case passes first
time; `golden.test.ts` fails if the cases would need more than 20.
Two prompt fixes came with them, after Flash-Lite failed `voice-note` and
retried `transfer` on `main`: each extractor prompt now says a named
business is the merchant even when it is not in the Merchants list, and
the bucket line no longer asks for lines on income and transfers.

Needs/wants accuracy check (2026-10-28; TESTING.md): `npm run
eval:buckets` replays a seeded sample of the Notion-imported expenses
(owner-set buckets) through `extractFromText` with the private rules and
prints agreement, per-category confusion, model mix and mismatches. Reads
through `finflow_readonly` only; local only, never in CI.

Notes are copy-edited (#27, 2026-10-28; DECISIONS.md). The `NOTES`
instruction now asks Gemini, in the same request, to fix spelling, typos,
punctuation and grammar and to join broken fragments with connectors,
keeping the owner's wording and adding no facts. `golden:text-with-note`
sends a typo-laden reason and checks the corrections are present, the typos
gone, and the note no longer than a copy-edit allows. The raw text, caption
and voice `file_id` stay in `ingestions.raw_payload` (voice audio in S3),
written with the extraction after Gemini answers, so the original of every
saved card is recoverable.

Eval budget (2026-10-28; DECISIONS.md, TESTING.md): the eval replays a
case whose exact Gemini request (hashed with the model chain, stored as
`request_sha256` in its golden) already passed, and calls Gemini only for
the rest. "Today" is pinned and an edit patches its base's recording, so a
full live run is 18 requests for 18 cases. CI writes live passes' request hashes into the
`goldens` artifact for the PR to commit. A nightly workflow at 06:07 UTC
runs every case live with the model chain rotated per case, reports each
429's `quotaValue`, and keeps one `eval-nightly` issue open while it fails.

`/pending` (#29; DECISIONS.md 2026-10-28): the owner sends `/pending`
and the bot resends the card of every row of that chat still `pending`,
oldest first, with the buttons its checks allow today; with none it
replies "No pending cards.". It asks Gemini nothing and runs before the
date/correction wait, so it cannot be taken as a date or a correction.
A card that fails to resend is logged and the rest still go out. This
covers a card whose send failed after its row was saved. It is one entry
of the command table now, and so in the command menu (below).

Batch position in acks (#30; DECISIONS.md 2026-10-28): confirming or
discarding a card from a batch of 2+ replies `Saved. (k of n)` /
`Discarded. (k of n)`, in the toast and the chat message. The position is
read back from the tapped card's header, so a card resent by `/pending`
(no label) and a single card keep plain `Saved.` / `Discarded.`.
"Already handled." never carries it.

Tips (#31; DECISIONS.md 2026-10-29): every extractor prompt (text,
photo, voice, Edit) shares one line-amount rule. An expense's header is
the total paid including tax and any tip, even a tip printed below the
total; tax and tip are folded into the item lines in proportion to each
line's price, with no tax or tip line, and the lines sum to the header.
Golden cases `receipt-with-tip` (synthetic diner receipt) and `edit-tip`
check the amount paid as well as the line count. The Edit prompt also says
the current amount already holds the old tip, so a tip correction replaces
it rather than adding to it (#60: Lite answered 39.24 for 34.74).

Duplicate warning (Phase 3.5 PR 1; DECISIONS.md 2026-10-29): every saved
card (new message, `/pending`, Fix date, Edit) gets at most one `!` line
under Checks when it looks like an earlier copy: `Same photo as a card
from <day> (saved|still pending)` when the largest photo's
`file_unique_id` was sent before, else `Possible duplicate: CAD <amount>
on <date>, "<description>" (saved|still pending)`, with `(+n more)`, for
the same type and amount within 3 days (income also the same source)
among confirmed transactions and the chat's open cards. Expenses, income
and transfers are all covered. Confirm stays, nothing is stored, no
Gemini call, no migration. Watch how often it fires on daily identical
purchases (spec risk; the fix would be "same merchant when both have
one").

Merchant commands (Phase 3.5; DECISIONS.md 2026-10-29): `/merchants` lists
the visible ones sorted, with a hidden count, `/addmerchant Name` adds one,
`/delmerchant Name` deletes one. Each writes at once; the typed command is
the confirmation. Names match ignoring case; an add trims and collapses
spaces and refuses an empty, over-100-character or comma name (a comma would
split one merchant in the prompt's list). `/delmerchant` on a merchant that
saved transactions use hides it (`merchants.hidden_at`, migration 0010):
it stays on them, leaves the `Merchants:` line, and Confirm no longer links
it. `/addmerchant` on a hidden name unhides it. A new or unhidden merchant
is linked to every saved transaction with no merchant whose stored
extraction names it, and the reply gives the count; this is the backfill
path (a read-only report ranks candidate names, the owner adds the ones
worth it). Merchants are never created on Confirm. A merchant added at
12:00 is in the 12:01 Gemini request (`loadTaxonomy` reads the table on
every message) and a deleted or hidden one is not; no prompt text changed.
Commands run before the wait, from the allowlisted chat only, and never
reach Gemini.

Migration 0010 (`merchants.hidden_at`, nullable) was applied to production on
2026-10-29, before the hide-and-backfill PR (#61) merged.

Frequent-merchant hint (Phase 3.5; DECISIONS.md 2026-10-29): a saved card
whose merchant is in no `merchants` row (visible or hidden) while 3 or more
confirmed purchases name it gets one `💡 You've bought from X n times. Send
/addmerchant X to track it.` line, on every render (new message, `/pending`,
Fix date, Edit). Counts bot-era confirmed ingestions only (Notion imports have
no merchant names), with the link-on-add normalisation, excluding the card's
own message. Fail-open like the duplicate check; no Gemini call, prompt change
or migration.

Merchant matching fix (DECISIONS.md 2026-10-29): the merchant key now also
ignores apostrophe style (`’ ‘ ´` and backtick read as `'`), in one SQL
expression and its TypeScript twin. Link-on-add also links a transaction with
no ingestion (a Notion import) and no merchant when its whole description
equals the name, never part of it, and `/addmerchant` on a visible merchant
runs the link and replies `Already a merchant: X. Linked N past transactions.`
Owner action after deploy: re-run `/addmerchant McDonald's` to link the four
imported rows. No migration, prompt or golden change.

Merchant evidence on add (DECISIONS.md 2026-10-29, two confidence tiers):
`/addmerchant X` (new, unhidden or existing) links at once every transaction
with no merchant whose extraction merchant, `ingestions.media_merchant` or
(Notion import) whole description is X by key, and says `Linked N past
transactions that name it exactly.` Then it offers, never links, the ones whose
message text, caption or description mentions X as a whole word: a review
message, 8 rows at a time, one toggle button per row (`☐ Sep 15 · 12.50 ·
"…words around it…"`), Link selected / Select all / Skip and More ›. Ticks live
in the message's keyboard (stateless); Link selected writes only ticked rows
still without a merchant. Migration 0011 adds `ingestions.media_merchant`; the
one-off `npm run backfill:media-merchant` fills it from the archived photos and
voice notes (about 16 rows qualified on 2026-10-29). It reads only a message's
sole saved row, and only if that row is event 0; it asks for every business
the media names and stores one only when exactly one is named (at most 100
characters), counting the rest as skipped. No extraction prompt or golden
change. Aliases ("MK" for Maple Kiosk) are not handled yet.

Migration 0011 is applied to production. Owner/CoS actions, in order: merge
the PR (it auto-deploys code that reads the column), then from `lambda/`:
`RECEIPTS_BUCKET=finflow-receipts-$(aws sts get-caller-identity --query Account --output text) AWS_REGION=ca-central-1 npm run backfill:media-merchant -- --dry-run`,
check the proposed names, and run it again without `--dry-run`. Then re-run
`/addmerchant` for the merchants that matter to link and review.

Item-level tags (Phase 3.5; DECISIONS.md 2026-10-29): a caption or voice
note can tag one line ("the bananas were for Partner"). The card shows it
indented under that line (`  Tags: Partner`), and Confirm writes it to
`transaction_item_tags` (migration 0012) for that line only. Whole-message
context ("road trip snacks" → Travel) stays on the header's `Tags:` line and
`transaction_tags`, and a tag the model puts on every line is stored once
there; income and transfer tags are unchanged. An Edit sends each line's
tags back and can move one. All four prompts and the item schema changed,
so every golden re-ran live; new golden `receipt-line-tag` (19 of 20).
A line tag missing from the Tags list is dropped and the card warns
(`! tag "X" is not in lookup; "Bananas" will save without it`) with Confirm
still offered; an unknown event tag still fails checks. Confirm rolls back
on a tag it cannot find, and an old card repeating a header tag confirms.

Command menu (DECISIONS.md 2026-10-29): `src/commands.ts` is the one command
table. The handler's run table is typed against it, and the last step of the
deploy workflow registers it with `setMyCommands` (`npm run telegram:commands`;
token read from SSM and masked). A failed registration turns the deploy run
red; the code stays deployed.

Data API lockdown (security fix, DECISIONS.md 2026-10-30): every `public`
table had RLS off while Supabase's `anon` and `authenticated` held grants on
them, so the project's anon key could read the ledger through PostgREST.
Migration 0015 revokes everything those roles hold on `public` (tables,
sequences, routines, schema) and on `staging` and `marts`, and the default
privileges that would grant them new tables. Guarded by the dbt test
`data_api_roles_reach_nothing`, which the nightly runs on production.
**Pending:** CoS applies 0015 to production (`supabase db push`, dry-run
first) before the PR merges; owner turns the Data API off in the dashboard
as well (not required).

Recurring foundation (Phase 4.5 PR 1, DECISIONS.md 2026-10-30): migration
0016 adds `recurring_series` (name, kind, owner-confirmed cadence, match
keys), `transactions.recurring_series_id` with a composite FK on (series,
type) so a payment only joins a series of its own kind, a trigger that makes
`is_recurring` follow the link (an unlinked insert keeps its flag until 0017),
dated non-overlapping `recurring_pauses` (GiST exclusion, `btree_gist` in
schema `extensions`), `recurring_skips`, `recurring_exclusions` and
`recurring_dismissed`. The tables ship empty. dbt tests
`recurring_link_matches_series_kind`, `recurring_link_not_excluded` and
`recurring_pauses_do_not_overlap` run nightly; the fixture's recurring rows
are now linked to generic series. `lambda/src/recurring.ts` (pure, no I/O)
detects cadence from calendar slots (a month never logged is a missing
payment, not a cadence change), predicts windows and missed payments with
pauses and skips, computes the amount band, and matches descriptions as word
sets because the same bill is logged under drifting wording with no
merchant. No bot change yet: nothing calls the module.

Recurring menu (Phase 4.5 PR 2, DECISIONS.md 2026-10-31): `/recurring` lists
the series by kind with cadence, usual amount and next window (or how many
are not logged, or the pause), and every button edits that message in place.
A series' detail pauses it (from today or the first payment not logged;
until resumed, one or three months on, or a date the owner replies with),
resumes, renames (a reply to a prompt) and deletes it (asked first). ➕ Add
makes a series from a saved payment, suggesting the cadence its similar
payments show, and then opens the review of all history: candidates as
toggles (strong and previously flagged ticked, weak unticked) and an Apply
whose label states the counts, which links the ticked and excludes the rest
shown. The legacy-flag screen clears or makes series from rows flagged
recurring with no series, and Suggestions tracks or dismisses detector
proposals. Writes happen only on taps whose labels say what they write;
repeats write nothing. No Gemini call. Screens read the whole recurring book
per tap (`lambda/src/recurring-db.ts`) and derive everything in
`recurring.ts`.

Card links the series (Phase 4.5 PR 3, DECISIONS.md 2026-10-31): a card
that can be confirmed is matched against every series (no Gemini call,
fail-open). A strong match shows `Recurring: <series>` on the card, a note
line when the amount is outside the series' band, and a last row
`↻ <series> ✓`; Confirm links the payment. Tapping the row turns it into
`↻ not <series>` (keyboard only) and Confirm then saves the payment
excluded from that series. Confirm re-reads the series inside its
transaction, so a deleted or no-longer-fitting series saves the payment
unlinked and the reply says so. Fix date and Edit clear the old card's
buttons before asking, so its Confirm cannot save the corrected payment
linked to the series proposed for the old reading. Gemini's `is_recurring` guess is no longer
saved; with no match it shows as `Recurring: not tracked yet` and puts
`↻ Track as recurring` on the `Saved.` reply, which opens the add flow.

Debt account kind (financial-future PR A, DECISIONS.md 2026-10-31, branch
`feat/debt-account-kind`, in review): migration 0017 widens `accounts.kind`
to `savings | investment | debt`. An extra loan payment is a transfer from
chequing into a debt account (in `transfers`, `account_kind = debt`); the
minimum payment stays a `needs` expense line. The dbt test
`debt_account_only_receives_transfers` fails on a transfer from a debt
account or an income source depositing into one. The bot needed no change;
a journey with a neutral `Car loan` account proves it. Migration 0017 must
be applied before merge. It takes the number the Phase 4.5 backfill CHECK
had pencilled in, so that migration (and the docs and comments that call it
0017) moves to the next free number when it is written.

Financial-future metrics (PR C, DECISIONS.md 2026-10-31, branch
`feat/financial-future-metrics`, in review): the 50/30/20 monthly view in
the contract, `fct_monthly_summary`, MetricFlow and `check_metrics.py` (25
metrics). `spendable_income = income - savings_income`; `financial_future
= transfers - withdrawals` (money actually moved, so a loan's extra payment
counts and a withdrawal lowers it); `needs_pct`, `wants_pct`,
`financial_future_pct`, `unallocated_pct` as shares of `spendable_income`
(null when it is 0); `financial_future_target` and `financial_future_gap`
in dollars; the three `*_target_pct` from the new one-row `budget_targets`
table (migration 0018, seeded 50/30/20, overridden in the untracked seed
overlay). `financial_future_identity` holds `spendable_income = spend +
financial_future + unallocated_cash` every month, nightly on production too;
`fixture_financial_future_expected` checks the spec's worked example, a car
loan month, June's interest and withdrawal, and two null months by hand.
Migration 0018 must be applied before merge. No bot or Telegram change
(Phase 5 charts the mart).

Nightly fix for issue #99 (branch `fix/financial-future-empty-months`, in
review): MetricFlow left `financial_future_gap` and `financial_future_pct`
null in a month with no transfer and no withdrawal, and the gap null in a
month with no income but money moved, because a derived metric has no row
in a month where none of its inputs has one. The three metrics now coalesce
those inputs; the contract and the mart were right. The fixture gains
2026-03 (only a withdrawal), 2026-04 (only a transfer) and 2026-05
(income, interest and spend, nothing moved). No migration.

## Next concrete step

Phase 4.5 — Proactive nudges, PR 4 (`feat/nudge-infra`, Terraform only) in
review: the `finflow-nudge` Lambda shell (bootstrap stub, no Function URL,
reads three SSM parameters), its log group, and an EventBridge Scheduler
schedule at 09:00 America/Toronto whose role may only invoke that function;
the deploy role may also update its code. After merge, `terraform plan`
should show only adds in `infra/nudge_lambda.tf` plus one in-place change to
`aws_iam_role_policy.ingest_deploy`; stop on anything else. Apply it
**before PR 5 merges** (PR 5's deploy step needs the function to exist);
until then the scheduled stub returns 200 and does nothing. The owner's
backfill can run now: `/recurring` → ⚑ Flagged and ➕ Add for each real
bill, salary and transfer. Then PR 5 (daily digest), PR 6 (migration 0017, after the owner's backfill), PR 7
(acceptance). `fixed_base_burn` stays thin until the backfill links real
history; expect it to rise then.

Phase 4 is accepted (2026-10-30). Optional and deferred: hand-verify real
numbers for one complete month against the owner's records (on hold until
the owner names a complete month; until then the production run proves the
pipeline and the invariants, not the figures). The follow-ups listed below
stay.

Phase 4 record. The metric contract is in
[SEMANTIC_LAYER.md](SEMANTIC_LAYER.md) (2026-10-29; fourteen since 2026-10-30): metrics with
formulas, mart columns and edge cases, and DECISIONS.md records the owner's
rulings. PR-B (migration 0013, the `finflow_dbt` and `finflow_analyst` roles,
`staging` and `marts` schemas) merged as #73. Both role passwords are set in
production and the `FINFLOW_DBT_HOST`, `FINFLOW_DBT_USER` and
`FINFLOW_DBT_PASSWORD` GitHub Actions secrets exist.

Nightly dbt on production (PR-F, 2026-10-30; DECISIONS.md, TESTING.md "The
nightly dbt build"): `.github/workflows/dbt-nightly.yml` runs at 08:45 UTC
and on dispatch from `main` only, never on `pull_request`. As `finflow_dbt`
through the session pooler with verified TLS, it runs
`dbt build --exclude tag:fixture`, `mf validate-configs` and
`check_metrics.py`; its public log shows node names and statuses only, and
a failure, step timeout or cancel keeps one `dbt-nightly` issue open.
Without the secrets (forks) or off `main` it skips green. **First production
dispatch on `main` (run 41157900716, 2026-10-30): green** as `finflow_dbt`;
`dbt build --exclude tag:fixture` passed all 87 nodes (every invariant test
and the reconciliation test), `mf validate-configs` passed, and
`check_metrics.py` reported "mf query matches fct_monthly_summary: 14
metrics, 5 months". The public log held node names and statuses only, with
host, user and password masked.

Pre-run check of `finflow_dbt` (2026-10-30, `has_table_privilege` and
`has_schema_privilege` over `verify-ca` TLS with the tracked CA, no writes): SELECT on `public.transactions` true;
INSERT, UPDATE and DELETE on it false; CREATE on schema `public` false;
CREATE on `staging` and on `marts` true.

A branch dispatch skips the build, so the spec's
throwaway-branch proof of the issue path no longer applies: the issue
table and open/close logic were exercised locally with a stubbed `gh`, and
the first real failure on `main` is the live proof.

MetricFlow (PR-E, 2026-10-30; DECISIONS.md 2026-10-30): `fct_transactions`
is a MetricFlow semantic model and `dim_date` its time spine, in
`dbt/models/marts/_marts.yml`; all fourteen contract metrics are MetricFlow
metrics of the same name, none excluded (`unallocated_cash_cumulative` is a
cumulative metric). `dbt/scripts/check_metrics.py` fails unless the metric
names in SEMANTIC_LAYER.md and the semantic manifest are the same set and
`mf query` equals `fct_monthly_summary` for every metric and month. The
`dbt` job runs `mf validate-configs` and the check, and proves the check
bites (`spend` without its self-funded filter, a metric missing from the
contract). Pins: dbt-core 1.12.6, dbt-postgres 1.11.0, dbt-metricflow
0.15.0 (metricflow 0.213.0), installed together on Python 3.12.

The dbt docs site is not hosted; browse it locally with `dbt docs generate`
and `dbt docs serve` (TESTING.md, "Browse the dbt docs locally"; DECISIONS.md
2026-10-30).

dbt marts (PR-D, 2026-10-30): four tables in schema `marts`, rebuilt in full
every run: `dim_date`, `fct_transactions` (one row per ledger line, with
effective tags), `fct_category_month` and `fct_monthly_summary` (one column
per SEMANTIC_LAYER.md metric). `monthly_summary_matches_hand_written_sql`
recomputes every month from `public` with the contract's reference SQL;
`fixture_sample_month_expected` pins the fixture's 2026-06 to hand-worked
values; `analyst_reads_every_mart` checks the analyst's grants after each
rebuild. The `dbt` job proves the reconciliation bites (a mart metric moved
by 0.01 fails it alone) and logs in as `finflow_analyst`. Contract change:
the month list runs to a later month if a row is dated in it (DECISIONS
2026-10-30). Ran green against production on 2026-10-30 (see nightly dbt above).
Every production month is partial until the owner says it
is complete (backfill under way); once one is, hand-verify its numbers
against the owner's records and record which months passed, no amounts.

dbt staging (PR-C, 2026-10-29): `dbt/` holds the dbt project (dbt-core
1.12.6, dbt-postgres 1.11.0, Python 3.12), three staging views in schema
`staging` (`stg_transactions`, `stg_transaction_items`, `stg_item_tags`)
and the ledger invariant tests, cited in TESTING.md as `dbt:<name>`. The CI
job `dbt` builds them as `finflow_dbt` on every PR against a synthetic
fixture, and proves that a line moved by 0.01 fails
`expense_lines_sum_to_header` and nothing else. `dbt` is now one of the
five required checks on `main`.

Withdrawals and income deposit accounts (PR 1 of 2, 2026-10-30;
DECISIONS.md 2026-10-30): the two known limits of `unallocated_cash`.
Migration 0014 adds `transactions.from_account_id` (null = chequing) and
`income_sources.deposit_account_id` (null = chequing), and replaces the
"transfer needs `to_account_id`" check with "a transfer names at least one
account, not the same one twice; only a transfer has `from_account_id`".
The bot extracts `from_account`: "took 200 out of Emergency fund" gives a
card with `From account: Emergency fund` / `To account: chequing`; "moved
500 from Emergency fund to Retirement account" names both; a deposit's card
is unchanged. The duplicate warning compares a transfer's two accounts. New
golden `transfer-withdrawal` (20 of 20). Order: apply migration 0014 to
production, put the owner's interest source's `deposit_account_id` in the
overlay, then merge (it auto-deploys code that writes the column).

Withdrawals in the contract and the marts (PR 2 of 2, 2026-10-30;
DECISIONS.md 2026-10-30): SEMANTIC_LAYER.md now has fourteen metrics.
Chequing is the null side of `from_account_id`, `to_account_id` and
`deposit_account_id`. New `savings_income` (income whose source lands in an
account) and `withdrawals` (account to chequing); `transfers` is chequing
to an account only; a move between two accounts is in no metric;
`unallocated_cash = income − savings_income − spend − transfers +
withdrawals` (its running sum follows); the residual rate (now `unspent_rate`) is unchanged.
`stg_transactions` and `fct_transactions` carry the from and deposit
accounts; `fct_monthly_summary` adds both columns.
(2026-10-31: the residual rate is renamed `unspent_rate` in the contract,
the mart, MetricFlow and `check_metrics.py`; formula unchanged; DECISIONS.md
2026-10-31.)
`dbt:transfer_has_account` now encodes migration 0014's check, so a saved
withdrawal passes. The fixture's June gains interest into savings, a
withdrawal and a move; its hand-worked values were redone. A withdrawal can
now be saved.

Phase 3.5 acceptance (2026-10-29): the journey tests are the check, not a
phone test. Against a throwaway Postgres (`cd lambda && npm run db:up`), then
`TEST_DATABASE_URL=$(npm run -s db:url) npm test -- tests/journeys/line-tags.test.ts tests/journeys/duplicates.test.ts tests/journeys/merchants.test.ts`,
then `npm run db:down`, the output was `Test Files 3 passed (3)`,
`Tests 25 passed (25)`. They cover the Done-when clauses: a line tag lands on
that line only (`line-tags`), a re-sent confirmed receipt shows the
duplicate warning (`duplicates`), and a merchant added from Telegram is
listed in the next extraction while a deleted one is not (`merchants`).
Migration 0012 was applied before the item-tags PR merged.

Owner: add `GEMINI_EVAL_API_KEY=<eval key>` to the gitignored `.env` in the
main checkout, then run `npm --prefix lambda run eval:buckets` for a
baseline agreement figure.

Watch the first nightly runs: the summary's quota line names
Flash-Lite's daily limit once it runs out.

S3 keys (2026-10-29): new media is archived at
`{source}/{yyyy-mm}/{id}.{ext}` in the same bucket, e.g.
`photo/2026-10/<uuid>.jpg` or `voice/2026-10/<uuid>.ogg`; the month is
America/Toronto at persist time. Existing rows keep flat `{id}.{ext}` keys, no
migration. Readers must use the stored `ingestions.media_path`, never
rebuild the key. The Lambda role's `s3:PutObject` is on `bucket/*`, so no
infra change.

## Open questions

- Whether `merchants.aliases` is seeded by hand or learned from extractions
  over time.
- Was anything spent or earned from 2026-08-13 to 2026-08-16, between the
  Notion import and the bot going live? Until the owner confirms,
  SEMANTIC_LAYER.md marks August 2026 partial.
- Grafana Cloud free tier's connection limits against a Supabase free project
  that pauses on inactivity — verify before building Phase 5 dashboards on it.

## Known risks

- Supabase free projects pause after ~1 week of inactivity. Hit empirically
  2026-08-27 (`INACTIVE`; bot silent). The nightly dbt workflow connects
  every day once merged, which should keep it warm; if it still pauses,
  restore from the dashboard.
- GitHub disables scheduled workflows in a public repo after 60 days without
  repository activity; the nightly dbt build and eval-nightly would then
  stop silently.
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
  without a card (logged as `card send error`; no reply to the owner
  until they send `/pending`); a retried photo/voice still uploads an extra S3 object
  before the insert decides; migration 0009 is forward-only once any
  update has `event_index > 0`.

Deploy role reads the bot token (DECISIONS.md 2026-10-29): the deploy role
may `ssm:GetParameter` exactly `/finflow/telegram/bot-token` (applied), and
the menu-registration step that uses it now exists (see Command menu above).
