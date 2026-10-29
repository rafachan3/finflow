# Decisions

Append-only log. Newest last. Each entry records what was chosen, what it ruled
out, and why — so a future session does not re-litigate a settled question.
Reversing a decision means adding a new entry that supersedes the old one, not
editing history.

---

## 2026-07-12 — Supabase over Neon for Postgres

Receipt images need object storage, and Supabase bundles a Storage bucket
(path recorded in `ingestions.media_path`). Supabase Studio's SQL editor also
doubles as the ad-hoc query console the project wanted, removing a separate
tool. Neon's Postgres was otherwise comparable.

**Cost:** free tier is 500 MB Postgres + 1 GB Storage; years of personal
transactions fit in a few MB. Accepted downside: free projects pause after
~1 week of inactivity.

---

## 2026-07-12 — Cloudflare Workers over a VPS for the bot

Webhook model rather than long polling means no process to keep alive and no
server to patch. Free tier is 100k requests/day against a personal volume of a
handful. Secrets management is built in.

---

## 2026-07-12 — Gemini Flash over Claude for extraction

Ingestion must cost $0, and Gemini's free tier accepts images and audio
natively — one API covers receipt photos, voice notes, and text. Claude is used
for the analytics agent instead, where an existing subscription makes the
marginal cost zero. Deliberately asymmetric: do not "simplify" by unifying on a
paid API in the ingestion path.

---

## 2026-07-12 — Amounts stored as `numeric(12,2)`, never float

Binary floating point cannot represent decimal currency exactly. Non-negotiable.

---

## 2026-07-12 — Human-in-the-loop confirmation on every ingestion

The bot always replies with the parsed transaction and inline Confirm / Edit /
Discard buttons. Nothing reaches `transactions` unconfirmed. LLM extraction is
good, not perfect, and a silently wrong expense corrupts every downstream
metric.

---

## 2026-07-12 — `ingestions` table separate from `transactions`

Separates "what arrived" from "what I confirmed". Gives an audit trail, a
natural home for the confirm/edit state machine, and the ability to reprocess
old receipts later with better prompts. `telegram_update_id` is UNIQUE so
Telegram's webhook retries are idempotent.

---

## 2026-07-12 — `bucket` and `cadence` live on `subcategories`

In Notion these were formulas. Needs/wants and fixed/variable are properties of
what kind of spend something is, not of an individual transaction, so they
belong on the subcategory row.

---

## 2026-08-08 — `AGENTS.md` is the source of truth; `CLAUDE.md` imports it

The repo is public and contributors may use Cursor, Codex, Gemini CLI, or
others, all of which read `AGENTS.md`. Keeping it as the real file with
`CLAUDE.md` reduced to `@AGENTS.md` plus Claude-only overrides avoids
duplicated content that drifts.

Chose the import over a `CLAUDE.md → AGENTS.md` symlink because a symlink would
force Claude-specific instructions (subagents, MCP, session protocol) into the
file every other tool reads. Owner-specific identifiers moved to an untracked
`CLAUDE.local.md`, and durable project state moved out of the context file into
`STATUS.md`, `DECISIONS.md`, and `DATA_MODEL.md`.

---

## 2026-08-10 — Terraform for infrastructure, on the existing stack

All provisionable infrastructure (Supabase project, Cloudflare Worker,
Grafana Cloud stack + dashboards) is defined in Terraform under `infra/`,
applied incrementally in the phase where each resource first appears.

**Ruled out:** migrating the storage layer to AWS. There is no durable free
Postgres on AWS (RDS free tier expires after 12 months, then ~$15+/month),
which would delete hard constraint #1. Terraform practice — the actual goal —
works against the Cloudflare, Supabase, and Grafana providers. AWS-specific
learning (IAM, VPC) happens in a separate sandbox, not in the repo holding
personal finances.

**Boundaries:** database schema stays in `supabase/migrations/`, never in
Terraform. Secrets are set via `wrangler secret` / provider dashboards, never
Terraform variables. State is local and gitignored — state files contain
secrets and this repo is public. BotFather and the Gemini API key are manual
steps, documented in the Phase 7 deploy guide.

---

## 2026-08-10 — No S3, no separate medallion layer

Receipt images stay in Supabase Storage (`ingestions.media_path`); no
bronze/silver/gold lake is added. The pipeline already implements the
medallion pattern at the right scale: `ingestions.raw_payload` + stored
images are bronze (raw, immutable, reprocessable), confirmed `transactions`
+ dbt `staging/` are silver, dbt `marts/` are gold.

**Ruled out:** S3 + lakehouse layers — duplicates the existing pattern across
a second cloud, adds IAM and credential surface to a public-repo project, and
none of the downstream stack (dbt, Grafana, MCP) reads S3. Data volume is a
few MB.

---

## 2026-08-10 — Images stay in Supabase Storage (settled, S3 re-examined)

The S3-for-images-only variant was weighed a second time and rejected by
explicit owner decision. It would fit under the cost cap (~pennies/month) and
offers the best Terraform provider for practice, but adds a second cloud's
credentials to the Worker, an AWS account that fails open on billing, and
splits storage that Supabase bundles — for zero functional difference on a
write-once, read-almost-never object.

**Ruled out:** S3 in any form for this project. AWS practice happens in a
separate sandbox repo, not here. This question is settled; a future entry may
supersede it, but do not re-raise it without new facts.

---

## 2026-08-10 — Hybrid: AWS for ingestion, Supabase for Postgres

**Supersedes** the 2026-07-12 Cloudflare Workers choice and the earlier
2026-08-10 "no S3" entry. Both were decided before the stack was actually
costed; this entry replaces them with numbers.

The ingestion path moves to AWS — Lambda + Function URL (replacing the
Cloudflare Worker), S3 for receipt images (replacing Supabase Storage), SSM
Parameter Store for secrets, CloudWatch for logs. Postgres stays on Supabase.

**Why the split.** Costed at ~150 transactions/month:

| Component | Monthly |
|---|---|
| Lambda + Function URL (1M req/mo free, **perpetual**) | $0.00 |
| S3 (~2 GB, 150 PUTs) | ~$0.05 |
| SSM Parameter Store (standard tier) | $0.00 |
| CloudWatch Logs (under 5 GB) | $0.00 |
| Egress (first 100 GB free) | $0.00 |
| **AWS total** | **~$0.05** |

Postgres is the entire cost of a full AWS migration and the least interesting
part to terraform: RDS `db.t4g.micro` ≈ $14/mo ($168/yr), Aurora Serverless v2
≈ $3/mo *only if it actually pauses* — and Grafana Cloud holds pooled
connections to its data sources, which would keep it awake at ~$44/mo
($528/yr). Roughly eight lines of HCL for $35–168/year.

**Ruled out:** full AWS migration. Also confirmed that AWS's July 2025 free-tier
overhaul removed the 12-month RDS allowance for new accounts — they now get
$200 in credits expiring at 6 months, so there is no free runway to lean on.

**What this buys:** genuine AWS + Terraform practice on the parts that teach
something (IAM roles and least-privilege policies, Lambda, S3 lifecycle and
Block Public Access, Parameter Store, CloudWatch, budgets), while staying
inside hard constraint #1. It also removes Supabase Storage's 1 GB image
ceiling, so the retention question is moot rather than deferred.

**New obligations this creates:**
- A `aws_budgets_budget` alarm at $1/month is a required resource, created in
  Phase 0 before anything else. Supabase and Cloudflare fail closed; AWS bills.
- Lambda talks to Supabase through the transaction pooler (port 6543), not a
  direct connection.
- Region `ca-central-1` — latency and Canadian data residency for financial data.
- Cloudflare leaves the stack entirely.

---

## 2026-08-10 — Budget scoped to `Project=finflow`, not the whole account

The Phase 0 `$1/month` budget filters on cost allocation tag
`user:Project$finflow`. A whole-account budget would fire on unrelated CLI
experiments and defeat the FinFlow cost constraint.

**Mechanics:** `providers.tf` applies `default_tags { Project = "finflow" }` to
every resource this root module creates. `aws_ce_cost_allocation_tag` activates
`Project` for billing. The budget's `cost_filter` keeps only that tag.

**Ruled out:** account-wide budget; filtering by service list (Lambda+S3+…) —
brittle as the stack grows and still mixes in non-FinFlow use of those
services.

**Caveat:** AWS rejects activating a cost allocation tag until that key has
appeared in billing data ("Tag keys not found"). Phase 0 therefore creates a
free SSM parameter (`/finflow/bootstrap`) tagged `Project=finflow` so the key
shows up, then you activate `Project` in Billing → Cost allocation tags (up to
24h). Untagged resources do not count — by design. AWS bills in USD, so the
alarm unit stays USD even though transaction currency is CAD.

---

## 2026-08-10 — Terraform owns the Lambda resource; CI owns its code

Terraform manages `aws_lambda_function`, its IAM role, and the Function URL.
The function's code is pushed separately by GitHub Actions via
`aws lambda update-function-code`.

**Why not let Terraform manage the code too** (the `archive_file` +
`source_code_hash` pattern, where `terraform apply` is the deploy): Terraform
state here is local and gitignored, because state embeds secrets and the repo
is public. CI has no state to plan against, so it cannot run `terraform apply`.
Deploying code through Terraform would mean either publishing state to a remote
backend or deploying only from the owner's laptop. The split is a consequence
of the earlier state decision, not an independent preference.

**Mechanics:**
- Function is created with a generated bootstrap stub (`data.archive_file` with
  inline content — no binary committed) so the resource can exist on first apply.
- `lifecycle { ignore_changes = [filename, source_code_hash] }` on the function.
  Without it, the first `terraform apply` after any deploy reverts the function
  to the stub — a silent rollback triggered by unrelated infra work.
- Actions authenticates by **OIDC**, assuming a role permitted only
  `lambda:UpdateFunctionCode` on this one function. No long-lived AWS keys.
- Terraform owns the OIDC provider and that deploy role.

**Ruled out:** committing a prebuilt zip to the repo; running Terraform from CI
with a remote state backend (adds an S3 bucket + lock table and puts secret-
bearing state in a place that needs its own access control, to save one CLI
call); Lambda versions and aliases (no traffic-shifting need at this scale).

**Known consequence:** `terraform destroy && terraform apply` produces a working
function running the stub, not the app. Re-running the deploy workflow is a
required step in any rebuild and must appear in the Phase 7 deploy guide.
Phase 2's acceptance check includes a clean `terraform plan` after a deploy,
which is what proves the two systems are not fighting.

---

## 2026-08-13 — Header/lines model with item-level classification

**Supersedes** the 2026-07-12 "`bucket` and `cadence` live on `subcategories`"
entry. The owner redesigned the taxonomy, and the actual Notion data
invalidated the old premise: Groceries alone split 82 needs / 47 wants row by
row, so bucket is not a property of the subcategory.

`transactions` becomes a header; classification moves to a new
`transaction_items` table — one row per receipt line, each carrying its own
`subcategory_id`, optional `item_type_id`, and needs/wants `bucket`. Every
expense has at least one line; line amounts, with tax allocated
proportionally at extraction, sum to the header amount. A third taxonomy
level (`item_types`, scoped per category) exists only where subcategory and
item type answer different questions: Food and drink, Housing, Health and
wellness. The taxonomy contract is docs/TAXONOMY.md.

Also in this redesign: `cadence` is dropped in favour of a per-transaction
`is_recurring` boolean (matching how the Notion "Recurring expense" checkbox
was actually used); the tag pile splits into context `tags` (multi-valued), a
single-valued `venues` lookup, and the existing `merchants` table; the
`funding_source` enum becomes a `funding_sources` lookup table.

**Ruled out:** item types on every category (redundant metadata where
subcategory already answers the only useful question); enforcing
lines-sum-to-header with database triggers (application logic + dbt tests
suffice at this scale); standalone beverage subcategories (beverages are item
types — the channel and the product are independent dimensions).

---

## 2026-08-13 — Public taxonomy template, untracked personal overlay

The repo is public; the owner's personal lookup values (accounts, income
sources, funding sources beyond 'self', personal tags, merchant list) are
not. The tracked seed migration contains only the generic, fork-ready
taxonomy from docs/TAXONOMY.md. Personal values live in an untracked
`supabase/seed.personal.sql`, applied by hand, with a tracked
`seed.personal.example.sql` as the template for forks.

Because earlier commits already carried personal references in the docs, the
git history was rewritten with `git filter-repo` and force-pushed — done now,
while the repo is young and has no forks, rather than left to the Phase 7
audit.

**Ruled out:** committing personal seeds and relying on obscurity; a private
fork holding the personal layer (two repos to keep in sync for a handful of
SQL inserts).

---

## 2026-08-13 — Notion import: via MCP, June 2026 onward

The Phase 1 history import pulls from Notion through the MCP server (settles
the STATUS open question — no CSV export step). Scope is 2026-06-01 onward by
owner decision: October 2025 rows were an early trial (108 of 109 lack a
transaction type) and May 2026 was explicitly excluded as well. Each Notion
row becomes one transaction with one line item — Notion has no receipt
grouping key, so no grouping is invented. Database and data-source IDs for
the import live in untracked `CLAUDE.local.md`.

Field mapping used for the import (historical; the live schema contract is
`DATA_MODEL.md`):

| Notion | Postgres |
|---|---|
| "Financial Future" rows | `type = 'transfer'` with a `to_account_id` — savings are not expenses |
| `Bucket` select (per row) | `transaction_items.bucket` (per line) |
| "Recurring expense" checkbox | `transactions.is_recurring` |
| Funding checkbox | `transactions.funding_source_id` → `funding_sources` lookup |
| Expense Category / Subcategory selects | `transaction_items.subcategory_id` (taxonomy v2) |
| Tags multi-select (context, venues, and merchants mixed) | Split three ways: context → `tags` + `transaction_tags`; venue/channel → `transactions.venue_id`; merchant names → `transactions.merchant_id` |

After the production import and spot-check passed, this mapping was moved
out of `DATA_MODEL.md` so the schema contract stays present-tense.

---

## 2026-08-13 — Needs/wants rulings are personal and live untracked

The owner's needs/wants classification guide (the 50/30/20 bucket test,
per-domain rulings, tag overrides, default-to-wants on missing context) is
deliberately not generalizable, so it lives in the untracked
`docs/BUCKET_RULES.local.md` — same pattern as the personal seed overlay.
Tracked `default_bucket` hints stay generic priors; where they disagree with
the personal guide (e.g. Financial fees), the guide wins at classification
time. A dedicated bucket-classifier subagent that applies the guide is
planned for the Phase 6 agent layer.

**Ruled out:** encoding the personal rulings in the tracked seed or
TAXONOMY.md (not fork-appropriate, and several rulings are item-level, not
subcategory-level); reworking `default_bucket` values to match the personal
guide (hints are priors, not verdicts — churn with no behavioral gain).

---

## 2026-08-13 — Merge Hygiene + Beauty into Personal care

Hygiene (under Health and wellness) and Beauty (under Personal) correlated
perfectly with Bucket in the Notion history — every Hygiene row was Needs,
every Beauty row was Wants — which made the split redundant with the
per-line bucket and split personal-care spend across two parents so it
could not roll up in one place.

Merged both into a single subcategory **Personal care** under Health and
wellness (`default_bucket` null). Existing `transaction_items.bucket`
values are left untouched: the merged subcategory deliberately mixes Needs
and Wants. Applied via forward migration 0005; seed migration 0002 is not
rewritten (migrations are append-only after merge). Notion left alone for
a separate pass.

**Ruled out:** keeping the split and relying on a cross-category rollup
view; encoding Need/Want in the subcategory name; rewriting Notion select
option lists wholesale (risk of wiping unrelated options — record-level
writes only, when Notion is updated).

---

## 2026-08-15 — Phase 2 quick-log uses hardcoded Other personal + wants

Phase 2 Confirm must write a `transaction_items` row without Gemini. Until
Phase 3 extraction exists, every quick-log confirmation uses subcategory
**Other personal**, `bucket = wants`, and `item_type_id` null. Description
and amount come from a dumb regex on the Telegram text.

**Ruled out:** keyword→subcategory maps in Phase 2 (throwaway logic before
the LLM path); using Other food and drink as the placeholder (would skew
food stats during skeleton testing).

---

## 2026-08-17 — GitHub OIDC trust policy accepts immutable repo-id `sub` claims

Repos created after 2026-07-15 emit OIDC subjects like
`repo:owner@OWNER_ID/name@REPO_ID:ref:refs/heads/main`. The Phase 2 deploy
role originally trusted only `repo:owner/name:ref:…`, so Actions failed with
`AssumeRoleWithWebIdentity`. Trust policy now lists both legacy and
immutable-id patterns; owner/repo ids are Terraform variables (public GitHub
API values).

**Ruled out:** requiring every fork to discover ids by trial deploy; using
long-lived AWS access keys in GitHub instead of OIDC.

---

## 2026-08-17 — Phase 3a: two Gemini specialists on the ingest path

Natural-language text (all of it — the Phase 2 regex is gone) is extracted by
**two sequential Gemini Flash free-tier calls** inside the existing Lambda, not
one combined prompt and not a Claude Code subagent on the webhook.

1. **Extractor** — facts + taxonomy (category, subcategory, `item_type`). No
   bucket. Taxonomy is loaded live from Postgres.
2. **Bucket specialist** — `docs/BUCKET_RULES.local.md` injected from SSM.
   Assigns `needs` / `wants` plus a short why.

Confirm still required. `ingestions` pending is written only after mechanical
checks pass (line amounts sum in integer cents, names exist in taxonomy).
`transactions` is written only on Confirm. The Telegram preview shows every
field that will land in the ledger, including tags, venue, funding, and lines.

`item_type` stays on the extractor: it is the same TAXONOMY.md contract as
subcategory, not a third specialist. Photos, voice, S3, and Edit buttons stay
later in Phase 3.

Phase 6's Claude `bucket-classifier` is the **same role on a different
runtime**: on-demand backfill / explain / owner-requested reclassify. It is
not on the Telegram hot path and does not silently overwrite confirmed
buckets.

**Model:** `gemini-3.6-flash` (free). `gemini-2.5-flash` 404s for new API
keys ("no longer available to new users"). Paid Flash and Pro were considered;
paying does not change the model on free vs paid Flash, and Pro is not
justified at this volume. Revisit only if receipts are systematically misread.

**SSM:** `/finflow/gemini/api-key` (standard SecureString) and
`/finflow/bucket-rules` (**Advanced** SecureString). The local rules file is
~6.1KB; standard parameters cap at 4KB. Advanced is $0.05/param/month.

**Ruled out:** stuffing bucket rules into the extractor prompt; a third
item-type Gemini call; Claude or DeepSeek on ingest; storing `transactions`
before Confirm; making `ingestions` wait until Confirm (breaks webhook
idempotency).

---

## 2026-08-17 — Extraction `meta` hashes, not a prompt version string

Each `ingestions.extraction` stores `usage` (already) and `meta`: Gemini
model name plus sha256 of (1) static extractor instructions, (2) the
taxonomy blob sent, (3) static bucket instructions, (4) the rules string
sent. Today's date is a placeholder in the extractor hash so daily logs
do not look like new experiments. Confirm is not an accuracy label.

**Ruled out:** a manual `PROMPT_VERSION = "3a"` constant (forgotten bumps;
SSM `BUCKET_RULES` can change with no deploy); an eval mart or MLflow in
Phase 3 (dbt does not exist yet; Edit diffs do not exist yet).

---

## 2026-08-18 — Date HITL: default today on text, Fix date before Confirm

Backdated logs and receipts need a real `occurred_on`, not silent "today."
Option C: **text** with no stated date defaults to today (America/Toronto)
and the preview warns `date defaulted to today`. **Photos** with no printed
date and no caption date omit Confirm (policy is in code; photos still
stubbed). Gemini must not invent today; empty date is defaulted in Lambda.

A stated date in the message wins. Before Confirm, **Fix date** sets
`ingestions.status` to `awaiting_date`; the next text is a date (`YYYY-MM-DD`,
`yesterday`, `Aug 10`), not a new expense. `date_source` on the extraction
JSON is `stated` | `today_default` | `missing` | `fix`. Category/amount Edit
stays later.

**Ruled out:** never defaulting text (every same-day Chipotle would need a
date); a full Edit flow in this slice; treating Confirm as extraction
accuracy.

---

## 2026-08-19 — Receipts bucket: SSE-S3 and account-id name, PutObject only

S3 names are global, so the bucket is `finflow-receipts-<account_id>` rather
than a bare `finflow-receipts`. Encryption is SSE-S3 (AES256), not a
customer-managed KMS key: KMS would add API cost against the $1/month cap,
and receipts are not a compliance workload that needs CMK audit.

The ingest role gets `s3:PutObject` on that bucket's objects only. No
`GetObject` until the photos slice (or later reprocessing) actually reads
bytes. No versioning: receipts are written once.

**Ruled out:** KMS CMK; a generic globally-racy bucket name; GetObject "for
later"; bundling Telegram download / Gemini vision in the same change.

---

## 2026-08-27 — Phase 3b: Telegram photos, Gemini vision, S3 on persist

Receipts are camera/gallery **photos** (`message.photo`). Caption text goes
to Gemini with the image. iPhone HEIC sent as a Telegram photo is already
JPEG; HEIC-as-file (`message.document`) and PDF stay out of scope.

Gemini sees Telegram file bytes, not S3. After checks, persistable photos
get a UUID, `PutObject` `{uuid}.jpg` or `.png`, then INSERT with that id,
`source = 'photo'`, and `media_path` = the key. Failed checks (other than
missing date) do not write S3 or Postgres. The ingest role still has no
`GetObject`. Bucket name is Lambda env `RECEIPTS_BUCKET` from Terraform,
not a new SSM parameter. Timeout is 60s.

Date policy from 2026-08-18 is live: printed or caption date required to
Confirm; otherwise persist without Confirm. Do not use send time or
default today. A photo while `awaiting_date` is “still waiting.”

**Ruled out:** PDF / document path; GetObject round-trip for vision;
defaulting a dateless receipt to today; treating a photo as a new expense
while a date reply is expected.

---

## 2026-08-28 — Phase 3c: Telegram voice notes, Gemini audio, S3 on persist

Voice notes are Telegram **`message.voice`** only (Ogg Opus). Caption text
goes to Gemini with the audio. `message.audio` (music files), video notes,
and documents stay out of scope.

Gemini sees Telegram file bytes, not S3. After checks, persistable notes
get a UUID, `PutObject` `{uuid}.ogg`, then INSERT with that id,
`source = 'voice'`, and `media_path` = the key. Failed checks do not
write S3 or Postgres. Same receipts bucket and PutObject-only ingest
role; still no `GetObject`.

Date policy matches **text**, not photos: a missing spoken/caption date
defaults to today (America/Toronto) with the existing warning. Confirm
stays. Do not use send time. A voice note while `awaiting_date` is
“still waiting.”

**Ruled out:** `message.audio` / document path; blocking Confirm on a
dateless voice note; a second S3 bucket; GetObject round-trip for
extraction.

---

## 2026-08-28 — One Telegram update is one extraction until multi-event

First voice-note phone attempt described two **independent headers**
in one recording (income and a transfer). Gemini returned a single
`income` with a line item; checks correctly blocked Confirm (`income
must have no line items`) and dropped the transfer.

**Same economic event, any channel.** One store trip described as a
receipt photo, as prose, as a list, or as a voice note is one
`transactions` row with `transaction_items` lines. The extractor
schema already has `items[]`; text and voice are not a second data
model. Do not split a grocery list into N Confirm cards.

**Multi-event (later Phase 3, after Edit)** is when
one message contains 2+ independent headers. That includes mixing
shapes: a grocery breakdown (one expense, several lines) **and** an
unrelated event in the same text, voice note, or photo caption (a
separate drink after the store; a resale booked as income; a
paycheque and a transfer). The trip stays one header with lines; each
other event is its own header. N pending ingestions, N Confirm cards.
Must replace `ingestions.telegram_update_id` UNIQUE without losing
webhook-retry idempotency.

Phase 3c stays one update → one `ingestions` row. Until multi-event
ships, send separate messages for distinct headers. A mixed
income+transfer note, or groceries plus an unrelated drink, is not
the 3c acceptance check. A single grocery trip in text or voice is
in scope for 3a/3c (one Confirm, several lines).

**Ruled out for 3c:** splitting one update into N ingestions; silently
keeping one header and dropping the other; treating a same-trip
item list as N transactions.

---

## 2026-08-29 — Funding source is expense-only

`transactions.funding_source_id` is “who paid for this spend.” It does
not apply to income (that is `income_source_id`) or to transfers
(`to_account_id`). Requiring it on every row was a one-table leftover
from Notion. A paycheck showing Funded by: self is the column being
filled because it is NOT NULL, not a real meaning.

**When it ships (Phase 3, before Edit):** nullable
`funding_source_id`; check constraint that expenses have a funding
source and income/transfer do not (`NULL`). Backfill existing
income and transfer rows to `NULL`. Confirm insert and extraction
validation match. Telegram preview omits Funded by except on
expenses. `docs/DATA_MODEL.md` changes with the migration.

**Ruled out:** inventing an employer-as-funder story; a transfer
“who funded this move” field until there is a real use; doing this
in the 3c voice PR.

---

## 2026-08-29 — One S3 bucket; prefixes later; do not rename

Voice and photos share `finflow-receipts-<account_id>`. Objects sit at
the root as `{uuid}.{ext}`. That is the 3c persist shape and it passed
phone test. The name is slightly wrong now that `.ogg` lives there;
the layout is slightly flat.

**Keep one bucket.** A second bucket is extra IAM, lifecycle, Terraform,
and env for the same ~$0.05/mo. S3 listing is prefix-based; split
buckets do not buy isolation we need.

**When prefixes ship:** `{source}/{yyyy-mm}/{uuid}.{ext}` where
`source` is `photo` or `voice` and `yyyy-mm` is the persist month in
America/Toronto (when the object was written, not `occurred_on`).
`ingestions.media_path` stores the full key. Old flat keys stay;
new writes use prefixes. Optional copy of existing objects is not
required for correctness.

**Do not rename the bucket.** AWS has no in-place rename; a new
`finflow-media-*` plus copy is cosmetics with real Terraform/IAM/env
churn. Keep `RECEIPTS_BUCKET`. Docs can say “ingest media.”

**Ruled out:** a voice-only bucket; renaming `finflow-receipts-*`;
partitioning by `occurred_on`.

---

## 2026-08-30 — Edit is one HITL: freeform correction, Gemini patch

Confirm already had Fix date. Category and amount still needed a path
before Confirm, including a wrong line on a grocery receipt. Separate
Fix amount / Fix category buttons break down on multi-line receipts
(which line? does the header scale?). A category picker is 11×54
Telegram buttons.

**One Edit button.** Sets `ingestions.status` to `awaiting_edit`
(migration 0008). Next text is the correction, not a new expense.
Gemini sees the stored extraction (no `usage`/`meta`/line buckets)
plus the owner text, same structured schema as the extractor, then
the existing bucket specialist. Photo and voice bytes are not
re-downloaded. Keep fields the correction does not mention. Keep
`date` unless they change it (`date_source` becomes `fix` only then).
Do not re-run the today-default date policy.

Keyboard: Confirm / Discard, then Fix date / Edit. Dateless photos
omit Confirm; Edit stays. While waiting for a date, hide Edit. While
waiting for a correction, Discard only. One outstanding wait:
`awaiting_date` or `awaiting_edit`. A photo or voice while waiting is
still waiting. Failed checks stay `awaiting_edit`. Passed checks
write the extraction and return to `pending`. Missing-date-only still
applies without Confirm, same as a dateless receipt.

**Ruled out:** Fix amount and Fix category as two date-like buttons;
an inline category/subcategory picker; re-fetching media; treating
Edit as a new extraction; a full line-item editor.


## 2026-10-12 — Post-Phase-3 scope: order, new phases, one parked item

New owner asks after Edit: context notes, two merchants in one
message, item-level tags, duplicate detection, merchant management
and recommendations, recurring-expense reminders, MetricFlow, and
several receipts in one send.

**Order.** Notes, then multi-event (closes Phase 3; two merchants in
one message *is* multi-event). Phase 3.5: item-level tags, duplicate
warning, Telegram merchant commands. Phase 4 gains MetricFlow. Phase
4.5: recurring reminders and merchant recommendations. Then Phase 5.

- Notes first: `transactions.notes` already exists and nothing writes
  it; every day without it is context lost for the agent layer.
- Item tags before Phase 4: they change the grain of tag spend, and
  marts built on header tags would be rebuilt.
- Reminders and recommendations share a scheduler and need history
  (marts), so they follow Phase 4. Recommendations are a frequency
  count over confirmed transactions, not an LLM call.
- MetricFlow uses the local `mf` CLI only. The hosted Semantic Layer
  APIs are dbt Cloud (paid), so Grafana keeps reading marts and a test
  keeps the two in agreement.

**Parked:** Telegram albums (several receipts in one send). Owner
decision: revisit only if needed. See ROADMAP.md "Parked".

**Ruled out:** folding the new items into Phase 3 (it has been "almost
done" since August; scope creep is the risk); an LLM for merchant
frequency.

## 2026-10-12 — No microservice split of the ingest Lambda

Asked whether the system should be split into microservices instead
of a monolith. It already is split by deployable and responsibility:
ingest Lambda (webhook), Postgres, dbt in Actions, Grafana, the agent
layer. Inside the ingest Lambda, modules split by concern (`telegram`,
`gemini`, `extraction`, `db`, `s3`, `handler`).

Splitting text/photo/voice/callbacks into separate functions would
need a router in front of Telegram's single webhook URL, more IAM,
more deploy paths, and more cold starts, while every piece still
shares the `ingestions` state machine in one database — a distributed
monolith, for one user at a few messages a day.

**Rule:** a new function only where the trigger or failure mode
differs. The Phase 4.5 scheduler is its own Lambda (cron, not
webhook). If `handler.ts` keeps growing, split it into flow modules
inside the same function when that code is next touched.

**Ruled out:** one Lambda per input type or per button; an API
gateway/router service; a queue between webhook and extraction
(Telegram retries already give at-least-once, and the update id is
the idempotency key).

## 2026-10-12 — Repo hygiene: PR tests, status in feature PRs, fix-forward

- `Deploy ingest Lambda` also runs on `pull_request` (same paths):
  `npm ci`, test, bundle. The AWS steps run only on push to `main`.
  Not a required check: with path filters, PRs that skip `lambda/`
  would wait forever on it.
- STATUS.md updates ride the next feature PR instead of standalone
  `docs:` PRs (18 of the first ~38 commits on `main` were docs-only).
  Post-merge results (phone tests) are recorded in the next PR.
- A personal name in a test fixture was replaced going forward.
  History was not rewritten: GitHub keeps PR refs a force-push cannot
  touch, so a rewrite costs every SHA since then and still leaves it
  visible.

## 2026-10-12 — Gemini overload: retry on a fallback model

Every logged bot error since 2026-09-30 was `Gemini HTTP 503` "high
demand" from `gemini-3.6-flash`. Single attempt → the owner saw
"Couldn't read that receipt". #24 added retries on the same model
(2s, 5s); the first receipt after deploy still failed all three
attempts over ~15s. Overload on one model lasts longer than seconds,
and each 503 itself took 3–6s.

Probe of five models with the owner's free-tier key, two rounds 20s
apart ("reply with OK"): 3.6 and 3.5-flash ~1s both rounds; 3.7 took
8–15s; 3.8 took 13s then 503'd; 3.5-flash-lite ~0.4s.

**Attempts:** `gemini-3.6-flash`, then `gemini-3.5-flash` after 2s and
after 5s, on 500/503/504 only. 429 and other 4xx fail at once. Primary
stays 3.6 (phone-tested on receipts since August). `meta.model`
records the model that answered the extraction and `meta.bucket_model`
the bucket step's, so fallback use is queryable.

**Ruled out:** moving the primary to 3.7/3.8 (the newest models are the
most contended on free tier); Flash-Lite as fallback (fastest, but the
weakest on dense receipts — a fallback should be the closest
substitute); the `gemini-flash-latest` alias (moves silently, breaks
reproducibility); more same-model retries (adds waiting, and a photo
makes two Gemini calls inside a 60s Lambda timeout); the paid tier
(no paid API in ingestion).

## 2026-10-12 — Flash-Lite as last fallback; paid tier if it fails

The next two receipts after the 3.5 fallback deployed also failed:
3.6 and 3.5 both 503'd. Replaying the bot's real receipt request
(153 KB: image, prompt, schema) twice per model: 3.6 503 both times;
3.5 503 then 429; `gemini-3.5-flash-lite` 200 both times in ~1.7s
with the right total, line sum, merchant, date, and no invented note,
but different subcategories each run. A tiny text probe minutes
earlier passed on 3.6: free tier sheds heavy requests first.

**Attempts:** `gemini-3.6-flash` → `gemini-3.5-flash` (2s) →
`gemini-3.5-flash-lite` (2s), on 429/500/503/504. 429 now moves on:
free-tier quota is per model, so the earlier "429 fails at once" only
held while every retry hit the same model. Other 4xx still fail at
once. Cards whose `meta.model` or `meta.bucket_model` is a Lite model
warn to check categories and buckets; Confirm stays.

**Owner decision:** if receipts still fail with Lite in the chain, move
ingestion to the paid Gemini tier. That relaxes the "no paid API in
ingestion" constraint and gets its own DECISIONS entry and cost check
when it happens.

**Ruled out (for now):** an async "busy, retrying later" queue (new
infra for a problem the paid tier also solves); Lite as primary
(classification wobble on every card, not just busy ones).

## 2026-10-12 — Multi-event: one ingestions row per event

One message can describe several separate purchases ("3 at Acme Mart
and 5 at Pharmaprix"). Owner choices: split by place (one event per
merchant or place; the same place or no place stays one expense with
lines; income and transfers are always separate), and separate cards
only, labelled "(i of n)", with no "Confirm all".

Each event is its own `ingestions` row. Migration 0009 adds
`event_index smallint not null default 0` and replaces the unique on
`telegram_update_id` with unique `(telegram_update_id, event_index)`.
All rows for an update insert in one transaction. Gemini returns
`{events}` in the text, photo, and voice extractors; Edit keeps the
single-object schema. One bucket call covers every line of every event:
one extractor call and at most one bucket call per message, regardless
of event count. Token usage is recorded on the first saved event only,
so a later eval mart does not double count.

**Retry fix.** A webhook retry re-runs Gemini and can return a
different set of events, so it can save indexes the first attempt did
not; the composite unique alone misses that. The batch insert now takes
`pg_advisory_xact_lock(telegram_update_id)` inside its transaction and
returns "duplicate" if any row for that update exists. The composite
unique stays as a backstop. One Telegram update is saved at most once.

**Ruled out:** one row holding an events array (callbacks and the
awaiting state would need an event index); an `ingestion_events` child
table (touches every DB function for a few KB saved); splitting a card
through Edit (to split, Discard and resend); "Confirm all"; one
bucket call per event (free-tier quota).

---

## 2026-10-28 — Automated regression suite replaces phone tests

The owner will not run manual phone tests again: every behaviour gets an
automated test, a PR that breaks one cannot merge, and no test touches
production.

Layers: unit (existing), integration and journeys against a throwaway
`postgres:17`, a live-Gemini eval over shared golden files, an inventory
check plus coverage floor, and a post-deploy smoke check that sends a
wrong secret and expects 401. Unit, integration, eval and inventory become
required checks on `main`.

- The eval blocks merges. This reverses the earlier "report, don't block"
  pick: only live Gemini can prove the split and extraction behaviour, and
  the owner wants no manual step. A Gemini outage holds PRs until it
  recovers (the job waits and retries for up to 20 minutes).
- The eval sends exactly the production request. Production sets no
  temperature, and a test-only setting would test a different bot.
- Phase 3's multi-event phone test is replaced by its journeys and golden
  cases.
- Test databases must be on `localhost`; the harness refuses any other
  host.
- Integration files run in one vitest worker: they share one database and
  truncate it per test, and `fileParallelism` is ignored inside a project.

**Ruled out:** Supabase CLI local stack (about 1 GB image and a second tool
version, while the migrations use no Supabase-only feature);
Testcontainers (a dependency for one container); PGlite (single
connection, so it cannot test the advisory lock); a staging environment
or automatic rollback (a second Supabase project or a Lambda alias;
revisit if a smoke failure ever ships).

---

## 2026-10-28 — Unknown merchants stay unattached

When Gemini extracts a merchant that is not in the `merchants` lookup, the
transaction saves with `merchant_id` NULL. The bot does not create
merchants. Many merchants are one-off purchases the owner never wants in
the lookup, and auto-creating rows would fill it with noise.

Today's behaviour: validation warns that the merchant is not in the lookup
and will be saved without one, and the save path looks the name up and
falls back to NULL. The name is kept reliably only in
`ingestions.extraction`, which stores the full extraction JSON. The
transaction `description` is Gemini's free text. It often includes the
brand because the prompt says to keep brand names, but nothing guarantees
it. A name like "Acme Mart" can therefore be recovered from the ingestion
row even when the transaction has no merchant.

**Ruled out:** auto-creating merchant rows on save. To add a merchant on
purpose, use the Telegram merchant commands planned for Phase 3.5.

---

## 2026-10-28 — Live eval: what triggers it and what it sends

The `eval` job calls Gemini only when the PR changes `lambda/src/`,
`lambda/tests/golden/`, `lambda/eval/`, `supabase/migrations/`,
`supabase/seed.personal.example.sql` (the seed shapes the taxonomy in the
prompt), the integration `global-setup.ts` and `env.ts` that load that
taxonomy, `lambda/package.json` or its lockfile, or `ci.yml`. Docs and
other workflow changes do not trigger it. Without a usable
base commit it runs every case.

- Bucket rules are empty, so the bucket call uses the bot's no-rules
  fallback: personal rules never leave SSM, and `expect` does not judge
  needs/wants.
- The 20-minute outage wait is one budget for the whole run, not per
  case, so a long outage fails the job in about 20 minutes.
- Gemini requests start at least 13 s apart (the free tier allows about
  5 a minute, and each case sends an extractor and a bucket call), at
  the cost of about 6 minutes per full run. The spacing lives in the
  eval's fetch wrapper, so the request bytes stay production's.
- A 429 whose `quotaId` is per-day marks that model out for the rest of
  the run: the 429 goes back to production, which moves down its fallback
  chain, and later requests to that model get the same 429 without a
  call. The run fails at once only when every model in the chain is out
  for the day (it resets at midnight Pacific, not within the 20-minute
  budget). Per-minute 429s and 5xx still wait.
- The job summary lists each case's attempts, answering model and
  result, and counts primary against fallback answers. A fallback answer
  is reported, not failed.
- `npm run eval` wraps vitest in `eval/run.mjs` because vitest rejects an
  unknown `--record` flag.

**Ruled out:** a temperature override or a forked prompt for the eval;
ffmpeg for the voice clip (`afconvert` encodes Opus, a stdlib script
writes the Ogg pages).

## 2026-10-28 — Live eval quota budget

Facts, read 2026-10-28 from
<https://ai.google.dev/gemini-api/docs/rate-limits>,
<https://ai.google.dev/gemini-api/docs/deprecations> and
<https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash>:

- Limits are per project, not per key; RPD resets at midnight Pacific.
- The docs no longer publish per-model free-tier RPM/RPD numbers. They
  point to AI Studio (<https://aistudio.google.com/rate-limit>) and say
  the limits are not guaranteed. The eval now logs `limit=` from a 429's
  `quotaValue`, which is the number Gemini itself enforces.
- `gemini-3.5-flash` (production's first fallback) was deprecated
  2026-05-19 and its requests are routed to `gemini-3.6-flash`.
  `gemini-3.6-flash` and `gemini-3.5-flash-lite` were deprecated
  2026-07-21, no shutdown date. Its daily quota is still counted under
  its own id (CI run 40742233785).

Counts from the code: a bot message is one extractor call plus one
bucket call when it has an expense line (income or transfer only: one
call); an Edit adds two more. A full eval run is at least 25 successful
requests (10 expense cases x 2, transfer x 1, edit-amount x 4), more when
a model answers 503 and the chain falls through, and up to double with
retries. Gemini's own 429s (`quotaValue`, CI run 40750690681) put the
free-tier daily limit at 20 requests for both `gemini-3.6-flash` and
`gemini-3.5-flash`. 503s seem to count: the eval project spent
`gemini-3.5-flash`'s 20 on 8 logged requests plus the earlier run's.
`gemini-3.5-flash-lite` then answered all 12 cases (about 25 requests)
without a 429; its limit is not yet known.

**So:** a full run (25+ requests) exceeds one model's daily 20, and one
free project gets at most about one full run a day, mostly on the
fallbacks. Five to 15 bot messages is 10 to 30 requests a day on the
production project. The low end fits `gemini-3.6-flash`'s 20; above
about 10 expense messages the bot falls to `gemini-3.5-flash-lite`
(`gemini-3.5-flash` is routed to `gemini-3.6-flash` anyway).

**Proposed, not built:** skip the eval when a hash of the `RELEVANT` files
matches the last green eval on the same PR (an `actions/cache` key on that
hash, saved only on success). Production's request is unchanged.

## 2026-10-28 — One Gemini request per message: needs/wants in the extractor

Reverses one line of 2026-08-17: "Ruled out: stuffing bucket rules into
the extractor prompt." The extractor now classifies needs/wants in the
same call, and the separate bucket specialist is gone.

**Why:** the binding constraint is now free-tier requests per day, not
classification quality. `gemini-3.6-flash` allows 20 requests a day
(2026-10-28, "Live eval quota budget"). An expense message cost 2
requests and an Edit 2 more, so 5 to 15 messages a day (10 to 30
requests) pushed busy days onto Flash-Lite, which gets categories and
buckets wrong more often. Now a message is 1 request and an Edit is 1,
so 5 to 15 messages fit the primary model's quota. That entry's request
arithmetic is superseded: a full eval run is 13 requests (10 expense
cases x 1, transfer x 1, edit-amount x 2), not 25.

- The rules sit in one delimited block, `Needs/wants rules:`, after the
  taxonomy in the system instruction. Static text, then taxonomy, then
  rules, then the user's message. They are still read from SSM at cold
  start and never stored or logged; only `rules_sha256` is.
- Each item returns `bucket_why` then `bucket`. `propertyOrdering` on the
  item schema fixes that order. It is documented on the API's `Schema`
  object ("Used to determine the order of the properties in the
  response", <https://ai.google.dev/api/generate-content>), so the model
  gives the reason after classifying the line and before the label.
- An Edit sends each line's stored `bucket` and `bucket_why` back and the
  patch prompt keeps them unless the correction changes that line or
  states needs/wants. Before, an Edit could not change a bucket.
- With no rules (empty SSM, the eval), the fallback text and the
  `(hint …)` on subcategories are in the same prompt.
- A message now either fully succeeds or fully fails. Before, a failed
  bucket call wasted the extractor's request.

**Risk accepted:** one prompt follows both the extraction instructions
and about 6 KB of personal rules. The eval guards extraction (amounts,
lines, merchant, date, note, split) but cannot judge buckets, since it
runs without the private rules. The card, Edit, the Lite warning, and
Confirm stay the safety net. Rollback is one revert, with no migration.

**Ruled out:** copying the old bucket in code when a patched line looks
unchanged (matching lines by position after an Edit adds or removes
lines is fragile; add it only if Edits flip untouched lines); a local
A/B replay of production history against the real rules (1 request per
row; only if the phone check shows a problem).

## 2026-10-28 — A fallback model's eval pass is a pass

Owner ruling: an eval case answered by a fallback model (for example
`gemini-3.5-flash-lite`) passes when its answer satisfies `expect`. A
real message sent that day would have been answered by the same model,
so the eval tested what production would have done. The job summary
still lists each case's answering model, so a run that leaned on Lite
is visible.

---

## 2026-10-28 — Inventory check, coverage floor, deploy after CI

Phase 3.6 enforcement.

- `docs/TESTING.md` is the behaviour inventory. A row cites its tests by
  exact title; `scripts/check-inventory.mjs` fails a row with no test or a
  title that is not in `lambda/tests` or `lambda/eval`. A title match, not
  a file path, so moving a test between files does not break the row.
- The coverage floor is lines 90, statements 90, branches 84, functions 98
  on `lambda/src`, measured on unit plus integration plus journeys at
  90.63 / 90.63 / 84.98 / 98.68. It only goes up. It runs in the
  `inventory` job, so it needs the database and cannot be measured on the
  unit project alone.
- The eval key must come from its own Google AI Studio project, because
  free-tier quota is per project.
- Deploy runs from `workflow_run` on a successful CI run for `main`, not
  from `push`, so a red CI run cannot ship. `workflow_run` takes no path
  filter, so a push with no Lambda change redeploys the same code.

**Ruled out:** a lint rule for private tooling markers in comments (the
owner rejected it); one deploy job inside `ci.yml` with `needs` (it would
run on PR builds too, or need an `if` on every step).

---

## 2026-10-28 — Bucket rule-following is checked by the eval, not the phone

The owner does not run manual phone tests. The phone check planned after
the single extraction call (rules overruling a hint, an Edit saying "that
one is a need") is now four live eval cases under a fictional ruleset,
`lambda/tests/golden/bucket-rules.synthetic.md`, plus one journey for the
Edit through Confirm. The eval sends the ruleset through the same
`bucketRules` argument production fills from SSM, so the request shape
matches a real message.

**Risk accepted:** the eval proves the prompt follows a ruleset, not the
owner's. A rule phrased unlike the synthetic ones could still be misread;
the card and Edit stay the net.

**Ruled out:** running the eval with the real rules (they would leave SSM
for a CI secret, and `--record` would write `bucket_why` text quoting
them into public goldens); a code guard that copies
untouched lines' buckets after an Edit (still only if Edits are seen
flipping untouched lines; the Edit case now checks for that).

---

## 2026-10-28 — Needs/wants accuracy truth is the Notion import only

`npm run eval:buckets` scores the bucket call against expenses that no
ingestion was confirmed into: the Notion import, where the owner chose
every `Bucket` by hand. Bot-created rows carry Gemini's bucket with only a
Confirm on top, so scoring against them measures the model against itself.
The check connects as `finflow_readonly` over TLS verified against
Supabase's public root CA (`supabase/prod-ca-2021.crt`), and runs only on
the owner's machine.

**Ruled out:** bot-confirmed rows as truth (self-agreement); running it in
CI (personal rows and rules would reach a public runner); unverified TLS
to the pooler.

---

## 2026-10-28 — Notes get a light copy-edit, not a rewrite

Owner ruling on #27. Gemini fixes spelling, typos, punctuation and grammar
in `notes` and joins broken fragments with connectors. It keeps the
owner's own wording and voice and never adds facts, reasons or details.
The old note rules stay (translate to English; no amount, merchant, items,
date or category; never from printed receipt text). It is part of the
`NOTES` instruction in the existing request.

The raw input needed no new column: `ingestions.raw_payload` already keeps
the full Telegram update (text, caption, voice `file_id`) and S3 the voice
audio, for every card that is saved.

**Ruled out:** full rewording for clarity or coherence (it drifts from the
owner's voice and invites invented detail); a second Gemini request just
for the note (free-tier budget, one request per message).

---

## 2026-10-28 — The eval replays a request that already passed

Approved by the owner (option B of the eval budget). Every golden case
still runs on every PR whose diff the eval considers relevant. A case
builds its exact Gemini request with no network call (the production
function, with fetch answering from `recorded`) and hashes the body plus
the model chain. When the hash equals the golden's `request_sha256`, the
recording goes through today's code and is checked against `expect`;
otherwise the case calls Gemini. An agent's change either alters the
request (the case goes live) or alters code after the response (the replay
and the journeys catch it). Re-asking an identical request only measures
model randomness or drift on Google's side, which the nightly run covers.

- **Hashes live in the goldens, next to `recorded`.** A hash is a claim
  about one recording ("this exact request produced this passing answer"),
  so the two move together in one reviewed commit, and a replay works the
  same locally, in CI and on any branch. `actions/cache` was ruled out:
  entries are evicted after 7 days unused, a PR cannot read another PR's
  entries, nothing is reviewable, and a cache miss quietly spends quota.
- **Refresh without committing from CI.** `npm run eval -- --hashes`
  writes each live pass's request hash and keeps `recorded`; `--record`
  also replaces `recorded` (the key from the environment or the repo-root
  `.env`). CI runs `--hashes` and uploads the goldens as the `goldens`
  artifact; the PR that changed the request commits them, and its next
  push replays. Until then a stale or missing hash only means that case
  calls Gemini, one request, within the cap.
- **The hash and the recording need not come from the same call.** The
  replay checks code after the response, and any recording that satisfies
  `expect` serves; golden.test.ts guarantees that. Re-recording from CI
  would churn the journeys, which quote the recordings, and on a day the
  Flash quota is spent it would swap in Flash-Lite's terser answers (the
  first run of this PR did exactly that).
- **"Today" is pinned in the eval** (2026-10-28). The system prompt carries
  the date, so a real date would change every request daily. `expect`
  checks only whether a date is set.
- **An edit patches its base case's recording** instead of re-extracting
  the base live. That makes its request deterministic and every case one
  request (16 for 16 cases). The base message is still checked live by its
  own case. A `--record` run re-records bases before edits, so an edit's
  hash matches the base it will patch next time.

Supersedes "Proposed, not built" in "Live eval quota budget" (an
`actions/cache` key on the hash of the RELEVANT files).

**Ruled out:** committing from CI (needs a write token on a public repo's
PR runs); hashing the RELEVANT files (any edit to `lambda/src/` re-ran
every case).

---

## 2026-10-28 — Nightly live eval with rotated models

Approved by the owner (option D of the eval budget). A scheduled workflow
runs every case against live Gemini, with no replay, at 06:07 UTC.

- **The time.** The eval project's daily quota resets at midnight Pacific:
  07:00 UTC in summer (PDT), 08:00 UTC in winter (PST). Cron is UTC and
  knows no DST, so 06:07 is the latest slot that is before the reset in
  both seasons (23:07 PDT, 22:07 PST); 07:xx would spend the next day's
  quota every summer night. GitHub delays scheduled runs under load,
  most at the top of the hour, hence :07 and 53 minutes of slack in
  summer. The run spends quota that would otherwise expire unused.
- **Rotation.** Case i (in run order) is sent to model (i + day) mod 3 of
  production's chain and falls through the rest in order, by rewriting the
  model in the request URL in the eval's fetch. Over three nights each case
  meets each model. PR runs keep production's fallthrough order, since PR
  gating should mirror production. A pass from a fallback is a pass
  (owner ruling, 2026-10-28).
- **Alerting.** A failure opens one issue labelled `eval-nightly` with the
  summary table (or comments on the open one), and the next pass closes
  it. AGENTS.md tells every session to fix open `eval-nightly` issues
  first. The job needs `issues: write` and creates the label if missing.
- **Measuring limits.** The summary lists each 429's `quotaValue` by model
  and quota id, so the first night Flash-Lite runs out names its daily
  limit. On 2026-10-28 it answered about 18 eval requests per run, several
  runs a day, with no 429.

**Ruled out:** rotating models on PRs; a second project for more quota
(Google's terms).

## 2026-10-28 — `/pending` resends cards; no scheduled resend yet

Rows are saved before their cards go out (the buttons carry the row id),
so a Telegram send that fails leaves a `pending` row the owner never sees
(#29). The owner now sends `/pending` and the bot resends the card of
every row of that chat still `pending`, oldest first, through the same
`sendCard` the first send uses, so the buttons follow today's checks (a
dateless receipt still has no Confirm). With none it replies "No pending
cards.".

- **Which rows.** `status = 'pending'` only. A card waiting for a date or
  a correction already has its prompt and keeps the single wait. The chat
  is read from the saved update (`raw_payload #>> '{message,chat,id}'`),
  so a second allowlisted chat never sees another chat's purchases; no
  `chat_id` column or migration.
- **Order in the handler.** After the allowlist, before the wait: while a
  card waits for a correction, `/pending` would otherwise go to Gemini as
  the correction.
- **No labels.** Resent cards drop "(i of n)": the numbering belonged to
  the original message.
- **Menu.** Not registered with `setMyCommands`; the repo registers no
  commands and typing the command works.

**Ruled out for now:** the Phase 4.5 scheduled Lambda resending rows still
pending after an hour (issue #29 option 2): it needs new infrastructure,
and `/pending` covers the gap.

## 2026-10-28 — Batch position in Confirm/Discard acks (#30)

- **Source of truth.** `withPosition` reads the " (k of n)" off the first
  line of the tapped card (`callback_query.message.text`) instead of storing
  `n`: only `event_index` is persisted, and `n` also counts offers that were
  never saved, so a migration would be needed for what the card already says.
- **Resent cards.** `/pending` cards carry no label, so their acks do not
  either; an ack always matches the card the owner tapped.
- **Scope.** Only "Saved." and "Discarded."; "Already handled." is unchanged.

## 2026-10-29 — A tip is folded into the item lines, like tax

A receipt with a tip below its printed total came back with tax and tip
spread unevenly across the lines by a fallback model, and two Edits of it
were dropped (#31). No prompt mentioned a tip, and the taxonomy has no tip
subcategory, so a tip line has nowhere honest to go.

The tip follows the 2026-08-13 tax rule. For an expense, the header amount
is the total paid, including tax and any tip (pourboire, gratuity), even
when the tip sits below the printed total. Tax and tip are folded into the
item lines in proportion to each line's price, any leftover cent goes on
the largest line, and no line is a tax or tip line. The lines still sum to
the header, so the existing checks are unchanged.

- **One sentence in every extractor prompt.** Text, photo, voice and the
  Edit (patch) prompt share a single `LINE_AMOUNTS` constant, which
  replaced four copies of the tax sentence. A tip said in words ("lunch 20
  plus 3 tip") is the same money as a printed one, and an Edit that
  changes the tip must keep the rule or its result fails the line-sum
  check and is dropped.
- **Goldens check the amount paid.** `expect` gained an optional `amount`:
  a line count alone would pass an answer that ignored the tip.

**Ruled out:** a Tip subcategory or tip line (the tip is part of what each
item cost; a separate line breaks per-item needs/wants); a second Gemini
call to allocate tax and tip (free-tier quota, and the prompt suffices);
allocating in code after extraction (the model already returns per-line
amounts, and the lines-sum check catches a miss).

## 2026-10-29 — Command menu registered by a deploy step; deploy role reads only the bot token

The Telegram command menu (`setMyCommands`) is registered by a CI step after
each Lambda deploy, reading the bot token from SSM Parameter Store. The deploy
role therefore gets `ssm:GetParameter` on exactly
`/finflow/telegram/bot-token`, and nothing else in the `/finflow/*` path.

- **`kms:Decrypt` is granted anyway.** The parameter uses the default
  `aws/ssm` key. AWS's Parameter Store page says `kms:Decrypt` is needed to
  read a SecureString and that access to `aws/ssm` cannot be managed by policy;
  it does not say an IAM grant is unnecessary. The grant is scoped to that one
  key and to `ssm.ca-central-1.amazonaws.com`, as the Lambda role's is.

**Ruled out:** registering the menu from the Lambda at cold start (adds a
Telegram call to the request path); storing the token as a GitHub Actions
secret (a second copy to rotate); `parameter/finflow/*` for the deploy role
(it would also expose the database URL and Gemini key).

## 2026-10-29 — A saved card warns about a likely duplicate; Confirm stays

The owner sometimes sends a receipt twice, or texts a purchase and then
photographs its receipt, and both got confirmed. Every saved card now
carries at most one `!` warning line under Checks when it looks like an
earlier copy. The owner chose the rule as specified, with no merchant
requirement.

- **The rule.** A match is either (A) an earlier, not-discarded card
  whose photo includes this card's largest-photo `file_unique_id`, or
  (B) the same type and amount (as `numeric`), dates at most 3 days
  apart inclusive, and for income the same income source. Rule B looks
  at confirmed `transactions` (so the Notion import counts) and this
  chat's open cards (`pending`, `awaiting_date`, `awaiting_edit`).
  Expense, income and transfer are all covered; transfers use type and
  amount only, so a second copy whose account was read differently still
  matches.
- **3 days.** Shorter than any pay period (weekly 7, biweekly 14,
  semi-monthly ~13 to 16), so the real next paycheck never flags, while
  Friday's deposit typed again on Monday does.
- **Dates.** The card's `date`; a dateless card (and a dateless open card
  it is compared with) uses the day it was sent, `created_at` in
  America/Toronto. A photo match shows the day the earlier card was sent.
- **Never a match:** anything from the card's own Telegram update (the
  events of one message, and a webhook retry), and discarded cards.
- **Precedence.** One line only. A photo match wins. Otherwise the nearest
  date, saved ahead of pending on a tie, then `(+n more)` for the rest.
- **No storage.** `findDuplicates(ingestionId)` runs in `sendCard` every
  time a saved card is rendered (new message, `/pending`, Fix date,
  Edit), so an Edit or Fix date that changes the amount or date gets a
  fresh answer. Fix date and Edit now render through `sendCard`. The
  warning goes into `warnings` only, so Confirm still depends on the
  checks alone. If the query fails, the card goes out without the
  warning.

**Ruled out:** checking in memory before the insert (a second code path
for `/pending`, Fix date and Edit); storing the warning on the row (stale
after an Edit or Fix date); a `file_unique_id` column with an index (a
migration for data `raw_payload` holds, at a volume a sequential scan
handles); blocking or asking "are you sure?" (adds a step); also
requiring the same merchant (cuts daily-coffee noise but misses a copy
whose merchant was read differently; revisit if the warning fires so
often it stops being read).

## 2026-10-29 — Merchant commands write directly and refuse an in-use delete

`/merchants`, `/addmerchant Name` and `/delmerchant Name` change the
`merchants` lookup at once. Owner decisions 2026-10-29 plus the defaults taken
for the questions not raised to them.

- **The typed command is the confirmation.** The "nothing is written without
  confirmation" rule guards the ledger from model guesses. A command is the
  owner's exact text, no model is in the path, and the write goes to a lookup
  table. A Confirm button would only echo what they typed.
- **`/delmerchant` refuses a merchant that saved transactions use** and says
  how many. Deleting would have to unlink confirmed ledger rows. Revisit if a
  typo merchant is linked before it is noticed; a rename command is the better
  fix then.
- **Matching ignores case, for add and delete.** The unique constraint is
  case-sensitive, and a near-duplicate would confuse the prompt's "use the
  listed spelling" rule. Whitespace is collapsed first, so a newline in a name
  becomes a space and only an empty, over-100-character or comma name is
  refused (a comma would split one merchant into two in the `Merchants:` line).
- **Commands are a table, run before the wait, after the allowlist.** A typed
  command must never be sent to Gemini as the correction a waiting card expects.
  `src/commands.ts` holds name -> description and the parser; the handler's run
  table is typed against it, so a command cannot be added without a handler.
- **The count and delete are one SQL statement** (`FOR UPDATE` on the merchant
  row). The foreign key still refuses a delete if a Confirm links the merchant
  after the count, so the ledger can never hold a dangling id.

**Ruled out:** a Confirm/Cancel card per command (friction, no safety gained);
unlinking on a button or a soft-delete column (a migration and re-add logic for
a rare case); a wait state for a bare `/addmerchant` (it replies with the usage
line instead); aliases, rename and case-insensitive matching at Confirm.

## 2026-10-29 — The command menu is registered by the deploy workflow

Overrides the design's "script run by hand". The last step of
`deploy-ingest.yml` reads `/finflow/telegram/bot-token` with decryption (the
grant from the entry above), masks it with `::add-mask::`, and runs
`npm run telegram:commands`, which sends `setMyCommands` built from the same
table the handler routes on.

- **A failed registration fails the run but does not roll back the code.** The
  step comes after the update and the smoke test, so the function is already
  live and healthy; the menu is cosmetic next to the ingestion path. It has no
  `continue-on-error`, so a bad token or a Telegram outage shows as a red
  deploy run rather than a menu that silently drifted. `setMyCommands` is
  idempotent, so re-running the job retries it. Rolling back would mean
  re-deploying the previous bundle for a cosmetic failure.
- **The script is bundled with esbuild, not run through `npx vite-node`.**
  `vite-node` is not a dependency of `lambda/`; `npx` would download an
  unpinned package into a step that holds the bot token. esbuild is already a
  devDependency and builds the Lambda bundle.

**Ruled out:** a hand-run script (nothing would catch a menu that drifted from
the table); registering from the Lambda at cold start (a Telegram call in the
request path); a GitHub secret for the token (a second copy to rotate).

## 2026-10-29 — An in-use merchant is hidden, not kept; adding one links past transactions

**Supersedes** the "`/delmerchant` refuses a merchant that saved transactions
use" part of "Merchant commands write directly and refuse an in-use delete"
(same day). Owner decisions. The rest of that entry stands.

- **`/delmerchant` hides a merchant that saved transactions use.** Refusing
  made the command nearly useless: a merchant worth removing has usually been
  used. `merchants.hidden_at` (migration 0010) is set; the merchant keeps its
  links on past transactions, leaves `loadTaxonomy` (so the next `Merchants:`
  line drops it), and Confirm's lookup skips it. A merchant no transaction
  uses is still deleted. `/addmerchant` on a hidden name unhides it.
- **Adding a merchant links past transactions.** A new or unhidden merchant
  fills `merchant_id` on every saved transaction where it is NULL and the
  stored extraction (`ingestions.extraction->>'merchant'` of the ingestion
  that produced it) names the merchant, spaces collapsed and case ignored.
  It never overwrites a link. This is the backfill: a read-only report ranks
  candidate names and the owner adds the ones worth keeping. Insert or
  unhide and link are one statement.
- **Merchants stay hand-created.** Confirm never creates one, so a misheard
  or one-off name does not grow the prompt's list.

**Ruled out:** auto-creating a merchant on Confirm; unlinking past
transactions on delete; a separate backfill command (adding the name is the
backfill); matching extractions by aliases or fuzzy similarity.

## 2026-10-29 — A card suggests adding a merchant the owner buys from often

Owner idea, approved the same day. A saved card whose extracted merchant is in
no `merchants` row but is named by 3 or more confirmed purchases gets one
`💡 You've bought from X n times. Send /addmerchant X to track it.` line.

- **Threshold 3** (`FREQUENT_MERCHANT_MIN`): two visits can be coincidence; a
  third is a habit worth a lookup entry. One constant, changeable in one place.
- **Counts only bot-era ingestions.** The count reads
  `ingestions.extraction->>'merchant'` of confirmed rows. The Notion import
  (2026-06 to 2026-08) carries no merchant names, so those 332 rows never count.
- **Same normalisation as the link-on-add backfill** (spaces collapsed, case
  ignored; one shared SQL expression in `db.ts`), so the count is exactly the
  set `/addmerchant` would link. Purchases of the card's own Telegram update
  are excluded, so a batch's events do not count each other.
- **A hidden merchant gets no hint.** Hiding is the owner's choice; "any
  `merchants` row, visible or hidden" suppresses it. A name `/addmerchant`
  would refuse (comma, over 100 characters) gets none either.
- **Same fail-open pattern as the duplicate check**: one read-only query in
  `sendCard`, logged on failure, card sent without the line. No Gemini call,
  no prompt change, no migration. Confirm looks the merchant up at tap time, so
  `/addmerchant` then Confirm on the same card links it.

**Ruled out:** auto-creating the merchant on the third purchase (merchants stay
hand-created); a button on the card (a callback and a new write path for a
command the owner can already type); counting pending cards.

## 2026-10-29 — Merchant matching ignores apostrophe style; adding links history imports and an existing merchant

**Amends** "An in-use merchant is hidden, not kept; adding one links past
transactions" (same day). Found in production: `/addmerchant` for a merchant
linked 1 past transaction, but 4 Notion-imported rows were left, because their
`description` spelled the apostrophe as U+2019.

- **One key everywhere.** The merchant key is now spaces collapsed, case
  ignored, and ’ ‘ ´ and the backtick read as an apostrophe. The SQL expression `MERCHANT_KEY` in
  `db.ts` drives link-on-add, the frequent-merchant hint and its lookup check,
  the duplicate-name check in `addMerchant` and `deleteMerchant`, and
  Confirm's merchant lookup (an exact spelling still wins a tie). `merchantKey`
  in `commands.ts` is the same rule in TypeScript and drives the card's "not in
  lookup" warning; an integration test runs both over the same strings so they
  cannot drift. The stored name keeps the spelling the owner typed.
- **A history import row is linked when its whole description is the name.**
  A transaction with no `ingestions` row (the Notion import writes none) and
  no merchant is linked when `MERCHANT_KEY(description)` equals the key of the
  merchant being added. Equality only, never substring or prefix: "Metro
  ticket" and "Bixi Monthly Pass" stay unlinked for "Metro" and "Bixi" alone.
- **Why equality is safe for these rows.** A Notion description is the owner's
  own title for the purchase. Where it is exactly a business name, the row is a
  purchase there; a longer title adds words that may mean something else, so it
  is left for the owner. A wrong link costs more than a missed one: it still
  needs a hand fix, while a missed one is a one-line re-run. Rows with an
  ingestion are never matched on description; their stored extraction decides.
  An existing link is never overwritten.
- **`/addmerchant` on a visible merchant links too.** It replies `Already a
  merchant: X. Linked N past transactions.` (just `Already a merchant: X.` when
  nothing links), so the owner can re-run it after a matching fix without
  deleting anything.

**Ruled out:** a separate relink command (re-running `/addmerchant` is it);
substring, prefix or fuzzy description matching; a migration that rewrites the
imported descriptions; matching ingestion-backed rows on `description`.

## 2026-10-29 — An Edit's tip correction replaces the old tip

The first nightly after #56 (run 40829256766, issue #60) failed `edit-tip`
on `gemini-3.5-flash-lite`, the same wrong answer on both attempts: amount
39.24 where the golden expects 34.74. The base receipt is 33.24 paid with a
4.50 tip; the correction is "the tip was 6.00, not 4.50". Lite added the
new tip on top (33.24 + 6.00) instead of swapping it (33.24 - 4.50 + 6.00).

The model was wrong and the prompt invited it. The patch request carries
the current extraction, which has no tip field: the old tip is already
folded into the amount and the lines. The shared line-amount rule says the
header includes "any tip ... in the message", which Lite read as "add the
tip in the correction". The patch prompt now says the current amount and
lines already include the tax and any tip, and a tip or tax correction
replaces the old value, with a worked example in other numbers (50.00 with
a 5.00 tip, corrected to 8.00, is 53.00, not 58.00). Only the Edit prompt
changed, so text, photo and voice requests keep their hashes.

After the change: two live `edit-tip` calls, both passed on the first
attempt (one answered by `gemini-3.5-flash-lite`, one by
`gemini-3.5-flash`).

**Ruled out:** loosening the golden (39.24 is a wrong amount paid that the
owner would have to fix on the card); treating it as a Lite flake (the
same wrong sum twice in a row is a reading of the prompt, not noise);
storing the tip as a field (a schema change for a case the prompt can
state).

**Known limit:** a correction that gives only the new tip ("the tip was
6.00") does not tell the model the old one, which the stored extraction
does not keep. The model can only guess there; the card shows the new
total before Confirm.

## 2026-10-29 — The nightly eval runs after the quota reset, on the one eval key

Supersedes the second-key entry from #65 (reverted) and reinstates the
2026-10-28 ruling against a second project for more quota. The nightly
eval shares `GEMINI_EVAL_API_KEY` with the PR evals again, and moves from
before the Gemini daily reset to just after it.

- **Why the second key goes.** Google APIs Terms §2(d), "API Limitations"
  (https://developers.google.com/terms): "You agree to, and will not
  attempt to circumvent, such limitations documented with each API." A
  second free project used by the same app to get more quota reads as
  circumvention. A suspension would also take down production extraction.
  The owner deleted the secret `GEMINI_NIGHTLY_API_KEY` and the extra
  project; its setup steps are gone from `docs/TESTING.md`.
- **The reschedule.** The cron went from `7 6 * * *` to `15 8 * * *`. The
  quota resets at midnight Pacific, so the run now gets a fresh 20 requests
  on each Flash model before any PR eval that day, instead of whatever the
  day's PR evals left. Cron is UTC and ignores DST: 08:15 UTC is 01:15 PDT
  (UTC-7) and 00:15 PST (UTC-8), after the reset in both. :15 keeps off
  the top-of-hour load on which GitHub delays scheduled runs.
- **Rotation unchanged.** The rotation shift is the UTC day number plus the
  case index. At 08:15 UTC the day number still advances exactly once per
  night, so each case still meets every model over three nights. No code or
  test change.
- **Trade-off.** The nightly now spends the day's Flash quota first, so on a
  busy day PR evals get less Flash and fall through to Flash-Lite, which
  counts as a pass (2026-10-28 ruling). The nightly's unused quota no
  longer expires unspent, but it is no longer free of the PRs' budget.

**Ruled out:** a second project or key for the nightly (Google's terms,
§2(d)); keeping the pre-reset slot (it measured only Lite on any day with
prompt-changing PRs, run 40829256766).

## 2026-10-29 — `/addmerchant` finds past purchases from all evidence, in two confidence tiers

Owner request: adding a merchant should find past purchases there from every
source, bot messages and Notion imports alike. Before this, link-on-add read
only the stored extraction's merchant and an import's whole description. A
read-only check that day found the merchant captured on confirmed photos 19/24,
voice notes 5/16 and text 17/62, so most misses are in the owner's own words or
in media the extraction did not name.

- **Tier 1, linked at once: an exact name.** A transaction with no merchant is
  linked when the merchant's key equals its extraction merchant, its
  `ingestions.media_merchant`, or (no ingestion) its whole description. These
  are statements that the purchase was at that business, so the typed command
  is confirmation enough. The reply says `Linked N past transactions that name
  it exactly.`
- **Tier 2, offered for review: a mention.** The key appears as a whole word or
  phrase (non-alphanumeric on both sides, after the key's case, space and
  apostrophe rules) in the message text or caption (`raw_payload`) or in any
  transaction's description. A mention is not a statement: "Metro" names a
  grocery chain and a subway, and "coffee next to Maple Kiosk" is not a
  purchase there. Constraint 3 (nothing written without confirmation) applies,
  so each row waits for the owner's pick. Substring matching was ruled out:
  "Metro" would match "Metropolitan".
- **The review is one toggle per row, state in the keyboard.** Owner design:
  `☐ Sep 15 · 12.50 · "words around the match"`, tap to tick, then Link
  selected, Select all or Skip; 8 rows per message and More › for the rest. The
  Lambda stays stateless: Telegram returns the message's keyboard with every
  tap, so a toggle only edits the keyboard and Link selected reads the ticked
  ids from it. Callback data is `mt:<transaction>`, `ml:<merchant>`, `ma`, `ms`
  and `mp:<merchant>:<last transaction shown>` (at most 50 bytes). Link selected
  writes only rows still without a merchant, and only for a merchant that
  exists and is visible, so a row linked elsewhere since the offer keeps its
  link. More pages by the last row shown, not a page number, so rows linked
  from an earlier page do not shift what comes next.
- **Media is re-read once, by a script, not by the Lambda.** `ingestions.media_merchant`
  (migration 0011) holds the business a re-read of the archived photo or voice
  note names. `npm run backfill:media-merchant` fills it for confirmed photos
  and voice notes whose extraction named no merchant, run by hand against
  production with `--dry-run` first. It skips a message that produced several
  events: its media names one business, which may not be every event's. The
  Lambda never reads S3 (its role may only `PutObject`); new photos and voice
  notes need no re-read, because the extraction prompt already asks for the
  merchant. The script's prompt asks only "which business does this name?" It
  is not on the ingestion path, so it has no golden case and leaves the
  extraction prompt hashes alone.
- **Aliases are deliberately not handled yet.** "mcdo" or "Tim's" for a
  merchant named McDonald's or Tim Hortons match neither tier. `merchants.aliases`
  exists but stays empty until the open question on seeding it is settled.

**Ruled out:** auto-linking mentions; substring or fuzzy matching; a
server-side selection store (it would make the Lambda stateful); re-reading
media in the Lambda on every `/addmerchant` (Gemini latency and free-tier quota on a
command, and an S3 read grant for the ingest role); page-number paging.
