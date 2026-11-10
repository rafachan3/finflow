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
invalidated the old premise: Groceries alone split close to evenly between
needs and wants row by row, so bucket is not a property of the subcategory.

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
owner decision: October 2025 rows were an early trial (almost none carry a
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
and 5 at Corner Pharmacy"). Owner choices: split by place (one event per
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
  (2026-06 to 2026-08) carries no merchant names, so those imported rows never count.
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
  merchant being added. Equality only, never substring or prefix: "Transit
  ticket" and "Bike Share Monthly Pass" stay unlinked for "Transit" and "Bike
  Share" alone.
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
read-only check that day found the merchant captured on most confirmed photos
but on well under half of voice notes and text, so most misses are in the owner's own words or
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
  transaction's description. A mention is not a statement: a one-word name like
  "Lark" is also an everyday word, and "coffee next to Maple Kiosk" is not a
  purchase there. Constraint 3 (nothing written without confirmation) applies,
  so each row waits for the owner's pick. Substring matching was ruled out:
  "Lark" would match "Larkspur".
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
- **Stale keyboards: two guards and one accepted race.** A toggle answers the
  tap only after the keyboard edit, so the button's spinner holds until the
  tick shows. A Link selected that links nothing because every pick already
  has a merchant (a Telegram retry, or a second tap on a stale copy) keeps the
  message's summary and only pops `Nothing linked: those already have a
  merchant.` What remains: an untick followed by Link selected before the
  untick's edit reaches Telegram sends the old keyboard, so the unticked row
  is linked. Accepted: the owner ticked that row once, it is one row, and
  closing the window needs selection state on the server, which the stateless
  Lambda rules out. A wrong link is fixed by hand in the SQL editor.
- **Media is re-read once, by a script, not by the Lambda.** `ingestions.media_merchant`
  (migration 0011) holds the business a re-read of the archived photo or voice
  note names. `npm run backfill:media-merchant` fills it for confirmed photos
  and voice notes whose extraction named no merchant, run by hand against
  production with `--dry-run` first. It skips a message that produced several
  events: its media may name another event's business. An event that failed
  validation is never saved, so a lone row does not prove a lone event: the
  row must be event 0 (no earlier event dropped), and the script asks for every
  business the media names and stores one only when exactly one is named and
  it fits a merchant name (100 characters), so a dropped later event's
  business cannot be linked to this purchase. The rest are counted as skipped. The
  Lambda never reads S3 (its role may only `PutObject`); new photos and voice
  notes need no re-read, because the extraction prompt already asks for the
  merchant. The script's prompt asks only "which business does this name?" It
  is not on the ingestion path, so it has no golden case and leaves the
  extraction prompt hashes alone.
- **Aliases are deliberately not handled yet.** "MK" or "Maple's" for a
  merchant named Maple Kiosk match neither tier. `merchants.aliases`
  exists but stays empty until the open question on seeding it is settled.

**Ruled out:** auto-linking mentions; substring or fuzzy matching; a
server-side selection store (it would make the Lambda stateful); re-reading
media in the Lambda on every `/addmerchant` (Gemini latency and free-tier quota on a
command, and an S3 read grant for the ingest role); page-number paging.

## 2026-10-29 — Line-only tags get their own table; header tags stay whole-transaction

Phase 3.5 item-level tags. Owner decision (spec open question 1): additive
storage.

- **Two grains, each fact once.** `transaction_tags` keeps context for the
  whole transaction ("road trip snacks" → Travel), and stays the only place
  income and transfers (no lines) carry a tag. New `transaction_item_tags`
  (migration 0012) holds context the owner gives for one line only ("the
  bananas were for Partner"). A line's effective tags are both; Phase 4's
  `stg_item_tags` model unions them.
- **Canonical form, in code.** `normalizeTaxonomyNames` runs `canonicalTags`:
  a tag every line of an expense carries moves to the header (a one-line
  purchase "for Partner", or a model copying a header tag onto each line),
  a line drops tags the header has, and both lists lose repeats. The eval's
  `mismatches` judges tags through the same function, so the golden checks
  what Confirm stores, not the raw answer.
- **An unknown line tag warns; an unknown header tag still blocks.** A line
  tag missing from the owner's Tags list is dropped in
  `normalizeTaxonomyNames`, before `canonicalTags`, and the card says
  `tag "X" is not in lookup; "<line>" will save without it` (the line keeps
  `dropped_tags` so `/pending` shows it again). Dropping first means a model
  that copies an unknown tag onto a one-line receipt cannot turn it into a
  header tag. A wrong guess about who one line was for is not worth losing the
  whole receipt to a card with no Confirm (constraint 6). An unknown tag on
  the event is a separate check in `validateExtraction` and is unchanged: it
  fails checks. Confirm's `insertTags` throws `unknown tag at Confirm` rather
  than skip a name it cannot find, so a tag that slips past both checks
  rolls the transaction back instead of saving without it. The prompt's
  example names no real tag (`"the bananas were for <a name from the Tags
  list>"`): the seed's example name is not in the production list, and a
  copied one would only be dropped.
- **One request still.** The `TAGS` rule is in all four prompts (text,
  photo, voice, Edit), and the item schema's `tags` sits between
  `item_type` and `bucket_why`, so who a line was for is settled before
  the bucket reasoning. Every golden's request hash changes once.
- **Deviations from the spec (written against 7a86bee).** The migration is
  0012, not 0010: 0010 (`merchants.hidden_at`) and 0011 (merchant evidence)
  landed first. `canonicalTags` also removes repeats from the header list,
  which the spec did not name: a repeated header tag would break
  `transaction_tags`' primary key at Confirm. The new golden's recording
  and hash come from one local live run, so CI calls Gemini only for the
  18 re-hashed cases. The ROADMAP
  line "Tags move from the header to the line grain" is reworded to the
  additive design. "An Edit can change a line tag" is a TESTING.md row
  guarded by a scripted journey and a request-shape test, with no golden:
  the cap is 20 and this PR brings the count to 19.

**Ruled out:** moving every expense's tags to its lines (backfill and
delete, N copies of one header fact, a deploy-order hazard where the old
Lambda writes header rows the new invariant forbids, and not reversible);
deterministic caption parsing (only the model can tell which line "the
bananas" means).

## 2026-10-29 — Metric contract: wants is discretionary, savings rate is residual, unallocated cash proves the move

Phase 4 PR-A. `docs/SEMANTIC_LAYER.md` is created with twelve metrics. The
owner ruled on four definitions; the chief of staff took the spec's
recommendation on the rest without asking.

Owner decisions:

- **Discretionary spend is `wants_spend`.** Own spend lines with
  `bucket = 'wants'`. "Discretionary spend" is a synonym in the contract,
  with no separate metric, mart column or MetricFlow name. The roadmap's
  wording is met by the synonym. **Ruled out:** ARCHITECTURE.md's
  "self-funded expenses except Rent" (subcategory ≠ Rent). It predates
  per-line buckets and is really "spend ex-rent", which SEMANTIC_LAYER.md
  keeps as a recipe for Phase 5.
- **Savings rate is `(income − spend) / income`.** A residual rate, null when
  income is 0. **Ruled out:** ARCHITECTURE.md's "transfers / income", which
  swings with when money is moved rather than how much was spent.
- **`unallocated_cash` = income − own spend − transfers to savings and
  investment accounts, per month, plus `unallocated_cash_cumulative`.** The
  owner needs proof the surplus actually left chequing, because idle cash
  gets spent by mistake the next month. Positive means money still to move.
  A transfer's destination type is `accounts.kind` through
  `transactions.to_account_id`. `transfers` stays its own metric. Phase 4.5
  may nudge on it; no nudge is built here. **Ruled out:** making transfers
  the savings rate (above); a balance from bank data (the ledger has no
  opening balance, so the running sum is drift since 2026-06-01).
- **Expenses someone else paid for are in no spend metric**, and are
  reported as `external_spend`. **Ruled out:** counting them in
  `fixed_base_burn` as "what living costs".
- **`fixed_base_burn` = own needs lines on recurring transactions**, with
  `variable_needs` (needs not flagged recurring, such as groceries) next to
  it, so `needs_spend = fixed_base_burn + variable_needs`. Food is a need but
  variable and partly avoidable, so it is not fixed. **Ruled out:** all
  recurring spend (a recurring want is not base).

Defaults taken by the chief of staff (spec recommendations, not asked):

- Refunds count as income; there is no refund flag. Spend and income are
  both overstated by a refund; `unallocated_cash` and the savings-rate
  numerator stay exact. **Ruled out for now:** a migration adding
  `income_sources.kind` to net refunds, until a refund visibly distorts a
  month.
- `needs_wants_ratio = needs_spend / wants_spend`. **Ruled out:**
  `needs / (needs + wants)`; one ratio, not both.
- A marts-only `finflow_analyst` role for Grafana and the MCP (PR-B), and
  `dbt` as a required check on `main` (PR-C).
- `transfers`, `external_spend` and `variable_needs` are metrics, not
  side columns: the owner asked to see each, and CLAUDE.md requires every
  reported number to trace to a definition.

Open: whether anything happened from 2026-08-13 to 2026-08-16 (after the
Notion import, before the bot went live) is not confirmed by the owner.
SEMANTIC_LAYER.md marks August 2026 partial until it is; nothing is
backfilled.

## 2026-10-29 — dbt writes only its own schemas; the analyst role sees marts only

Phase 4 PR-B, migration 0013. dbt cannot run as `finflow_readonly` (it builds
views and tables), and the constraint behind the request is that dbt must never
change the ledger.

- **`finflow_dbt`** reads `public` (`SELECT` on every table, plus a default
  privilege for tables later migrations add) and has `USAGE, CREATE` on the
  `staging` and `marts` schemas. It has no `CREATE` on `public` and no write on
  any ledger table. The schemas belong to the migrating role, so dbt can
  replace and drop its own relations but not the schemas.
- **`finflow_analyst`** (Grafana, Postgres MCP) has `USAGE` on `marts` and
  nothing on `public` or `staging`, so it cannot read the raw Telegram payloads
  in `ingestions`. This makes ARCHITECTURE.md's "`GRANT SELECT` on marts only"
  line true. `finflow_readonly` stays for the owner-local `eval:buckets`.
- **Mart reads come from a default privilege, not from dbt.** `ALTER DEFAULT
  PRIVILEGES FOR ROLE finflow_dbt IN SCHEMA marts GRANT SELECT ON TABLES TO
  finflow_analyst` makes every relation dbt creates readable at creation, so a
  rebuild or a new model can never leave the analyst locked out and dbt needs no
  `+grants` config. The statement needs the migrating role to be a member of
  `finflow_dbt`. A superuser is exempt, which is why local and CI runs would hide
  the failure; Supabase's `postgres` is not one. The migration grants itself
  the membership for that one statement and revokes it. The statement sequence
  was run as a non-superuser `CREATEROLE` owner of a scratch database on
  Postgres 17 to confirm it.
- **Passwords are set out of band.** Both roles are created `LOGIN` with no
  password, as `finflow_readonly` was, and the migration creates each only when
  absent (roles are cluster-wide and the local test cluster keeps them across
  database rebuilds).
- No `search_path` is set on either role: dbt qualifies every relation it
  creates or reads, so the default is enough.

**Ruled out:** giving dbt a write role on `public` or ownership of the ledger
(the failure mode this exists to prevent); one shared role for dbt and the
analyst (the MCP would read raw payloads and could write); relying on dbt's
`+grants` alone for analyst reads (a mart built without the config, or a failed
run between drop and re-grant, locks the analyst out); granting the analyst
`SELECT` on `staging` (not part of the contract, and views there read the ledger).

## 2026-10-29 — dbt's throwaway ledger is loaded by Python, into the integration suite's database

Phase 4 PR-C (dbt project, staging models, ledger invariant tests). Three
choices the Phase 4 design left open or did differently:

- **`dbt/scripts/test_db.py`, not a `test-db.sh` that calls `psql`.** The
  owner's machine has no `psql`, and `psycopg2` already ships with
  dbt-postgres, so the loader needs nothing dbt does not. It does what
  `lambda/tests/integration/global-setup.ts` does (drop and recreate
  `finflow_test`, drop `finflow_readonly`, every migration in order, the
  example seed), then the fixture, and prints the `FINFLOW_DBT_*` exports.
  **Ruled out:** a second database on the same server. Migration 0003's
  `create role finflow_readonly` is not idempotent, and a role that holds
  grants in two databases cannot be dropped from either harness, so two
  databases on one server would break whichever suite ran second. Sharing
  `finflow_test` means each suite rebuilds it for itself.
- **dbt runs as `finflow_dbt`, locally and in CI.** The loader sets that
  role a throwaway password (its name) on the local server and prints it as
  the dbt user, so every build proves dbt needs no privilege beyond
  migration 0013's.
- **`dbt/requirements.txt` pins dbt-core 1.12.6 and dbt-postgres 1.11.0
  only.** dbt-metricflow joins it with the MetricFlow PR (PR-E). The pair
  installs and runs together on Python 3.12 (verified 2026-10-29), and
  dbt-core 1.12.6 already pulls `metricflow==0.213.0`.

The invariant tests are singular tests, so `docs/TESTING.md` rows can cite
them as `dbt:<name>`. Two of them (`expense_funding_rules`,
`transfer_has_account`) restate CHECK constraints; they stay because a
staging join that dropped a name would pass the constraint and fail them.

## 2026-10-30 — The marts: ledger-line fact, full rebuild, reconciled to the contract's own SQL

Phase 4 PR-D (`dim_date`, `fct_transactions`, `fct_category_month`,
`fct_monthly_summary`).

- **`fct_transactions` is one row per ledger line** (each expense line, plus
  one row per income or transfer header), with each line's effective tags
  (its own plus its header's). Every contract metric is then a filtered
  `sum(amount)` over one table. **Ruled out:** a header fact plus an item
  fact (every needs/wants number would need a join), and line arrays on a
  header row (not additive).
- **Every mart is a table rebuilt in full on every run, nothing
  incremental by month.** The owner backfills past months through the bot
  at any time, so no month is ever closed; at a few hundred rows a full
  rebuild costs nothing.
- **The month list runs past the current Toronto month when a row is
  dated later.** The contract said "to the current Toronto month"; a bill
  logged ahead (dated next month) would then sit in `fct_transactions` but
  in no month of `fct_monthly_summary`. SEMANTIC_LAYER.md's Grain now says
  the list runs to that later month. `dim_date` starts on the first day of
  the first data month (the design said the first data day), so every
  month in it is whole.
- **`monthly_summary_matches_hand_written_sql` pastes the contract's
  reference SQL unchanged** and builds its own month list with
  `generate_series`, so neither `dim_date` nor any staging model sits on
  both sides. It returns month and metric names, never amounts.
- **The proof that it bites is a model mutation, not a fixture one.** Both
  sides read the same ledger, so changing the data changes both alike and
  can never make them disagree. CI instead adds 0.01 to the mart's
  `transfers` and requires the reconciliation, and nothing else, to fail
  (`transfers` is the one column no other test reads). The fixture's
  existing off-by-a-cent variant still fails only
  `expense_lines_sum_to_header`; the marts downstream of it are skipped.
- **`fixture_sample_month_expected`** holds the fixture's 2026-06 as
  literals worked out by hand (the arithmetic is in the test's header), to
  catch a misreading the mart and the reference SQL share. It is tagged
  `fixture` so the nightly on production can exclude it.
- **No dbt `grants` config.** The design asked for one, but migration 0013
  already gives the analyst `SELECT` on everything dbt creates in `marts`
  (entry "dbt writes only its own schemas" above). The singular test
  `analyst_reads_every_mart` checks it with `has_table_privilege` after
  every rebuild, so it also runs nightly on production; CI additionally
  logs in as `finflow_analyst` with the loader's throwaway password.

## 2026-10-30 — A transfer names the account it leaves; an income source names where it lands

`unallocated_cash` (SEMANTIC_LAYER.md, #72) had two known limits: interest
paid straight into a savings account counted as income that never reached
chequing, and a withdrawal from savings could not be recorded because a
transfer had only `to_account_id`. PR 1 of 2 changes the data model and
the bot; PR 2 changes dbt and the metric contract.

- **`income_sources.deposit_account_id`, nullable, null = chequing.** Where
  income from that source lands. The source already identifies it (an
  interest source belongs to one account), so no bot, prompt or card change.
  The owner's mapping lives in the untracked overlay.
- **`transactions.from_account_id`, nullable, null = chequing.** A transfer
  names `from_account_id`, `to_account_id` or both, never the same account
  twice (CHECK `transactions_transfer_accounts`), and only a transfer has a
  from account (`transactions_from_account_transfer_only`). A withdrawal is
  from set, to null. Rows saved before stay valid (from null, to set).
- **The bot extracts `from_account` beside `to_account`** with one shared
  prompt sentence in all four prompts. The card prints `From account` only
  when set and `To account` for every transfer that names one, chequing for
  the side left out, so a deposit's card is unchanged. No extra step.
- **The duplicate warning compares a transfer's two accounts**, so taking
  out what was just deposited is not flagged.

**Ruled out:** a deposit account per income transaction (the bot would
have to ask or guess on every paycheque, a friction regression, for a fact
that belongs to the source); a separate withdrawals table (a withdrawal is
a transfer in the other direction, and a second table would split every
transfer query and the duplicate check in two); a `chequing` row in
`accounts` (`accounts.kind` is savings or investment, and every existing
transfer would need a backfill).

## 2026-10-30 — Chequing is the null account: withdrawals and savings income in the contract

PR 2 of 2 after migration 0014. `docs/SEMANTIC_LAYER.md` reads chequing as
the null side of `transactions.from_account_id`, `transactions.to_account_id`
and `income_sources.deposit_account_id`, and every own expense as paid from
chequing. Fourteen metrics, two new:

- **`savings_income`**: income whose source's `deposit_account_id` is set.
  It stays inside `income`, so `savings_rate` counts interest as income not
  spent, as before.
- **`withdrawals`**: transfers with a from account and no to account.
- **`transfers`** narrows to chequing into an account (from null, to set).
  Every transfer saved before 0014 is one, so past months do not change.
- **A move between two accounts is in no metric.** It never touches
  chequing.
- **`unallocated_cash = income − savings_income − spend − transfers +
  withdrawals`**, chequing's net flow; `unallocated_cash_cumulative` is its
  running sum. `savings_rate = (income − spend) / income` is unchanged:
  moving money is neither saving nor spending it.

**Ruled out:** treating interest paid into savings as a transfer (it is
income the owner earned; making it a transfer would drop it from `income`
and `savings_rate`); `income` excluding savings income (it would understate
what came in, and the savings rate with it); netting withdrawals into
`transfers` as a negative amount (one signed column hides a month that both
moved money out and took it back, which is what the owner wants to see);
counting a move between accounts as a transfer and a withdrawal at once
(it would cancel in `unallocated_cash` but inflate both columns); keeping
`accounts.kind in ('savings', 'investment')` as the transfer filter (the
null test is the one rule the schema states; the kind check already limits
`accounts` to those two kinds, and a new kind needs a migration that
revisits this contract anyway).

The deposit account belongs to the source, so changing it restates every
past month of that source on the next full rebuild. Accepted: the marts
are rebuilt in full every night anyway.

## 2026-10-30 — MetricFlow: every contract metric, on the latest YAML spec, held to the mart by a script

Phase 4 PR-E. `fct_transactions` is the one MetricFlow semantic model
(primary entity `line`, `agg_time_dimension: occurred_on` at the model
level) and `dim_date` the time spine, in `dbt/models/marts/_marts.yml`,
written in dbt 1.12's latest metrics spec (no `type_params`, no measures).
All fourteen metrics in SEMANTIC_LAYER.md are MetricFlow metrics of the
same name; **none is excluded**. Pins: dbt-core 1.12.6, dbt-postgres
1.11.0, dbt-metricflow 0.15.0 (pulls metricflow 0.213.0); `pip install`
of the three together succeeds on Python 3.12, so no step-down was needed.

Settled with `mf validate-configs` and `mf query` on those versions:

- **Simple metrics take `filter:`**, a list of `{{ Dimension('line__…') }}`
  conditions ANDed together, so the ten money metrics are `agg: sum` of
  `amount` with the contract's filter, not `case when` expressions.
- **`fill_nulls_with` is dropped** from latest-spec metrics by dbt 1.12.6's
  parser (it reaches only legacy measures), so a simple metric is null, not
  0, in a month with no matching rows. The derived metrics therefore
  coalesce their inputs: `savings_rate` is
  `round((income - coalesce(spend, 0)) / nullif(income, 0), 4)`.
- **`needs_wants_ratio` is a derived metric, not `type: ratio`.** A ratio
  metric cannot coalesce its numerator, so a month with wants and no needs
  would read null where the contract says 0. The derived form is the
  contract's formula, `round(... / nullif(wants_spend, 0), 4)`, on numeric,
  so it matches the mart exactly (the 0.0001 tolerance is kept for safety).
- **`unallocated_cash_cumulative` is a cumulative metric**
  (`period_agg: last`, no window), so the month's value is the running sum
  at its end, carried over empty months by the time spine. MetricFlow
  0.213 validates a cumulative metric over a derived one but fails to
  query it, so `unallocated_cash` is one simple signed sum (income landing
  in chequing, minus own spend and deposits, plus withdrawals) rather than
  a derived metric over five others. The check holds it to the mart's
  composed formula every month.
- `dimension: time` written as a string loses the column's `granularity`
  in dbt 1.12.6; the mapping form `dimension: {type: time}` keeps it.
- `mf` finds `dbt/profiles.yml` in the working directory; no
  `DBT_PROFILES_DIR` is needed when it runs from `dbt/`.
- dbt 1.12.6's partial parse registered an edited metric twice, so the
  `dbt` job sets `DBT_PARTIAL_PARSE=false`.

`dbt/scripts/check_metrics.py` (stdlib and psycopg2) is the comparison:
the metric names in SEMANTIC_LAYER.md's table and in
`target/semantic_manifest.json` must be the same set, then `mf query` over
the mart's first to last month must equal `fct_monthly_summary` (money to
the cent, ratios within 0.0001, an empty mf cell 0 for money and null for
a ratio). It bounds the query to the mart's months because the cumulative
metric otherwise runs to the spine's end, a year ahead, and it fails on
any mf month the mart lacks. It prints metric and month only. The `dbt`
job runs it and two edited-YAML variants that must fail. `ci:<step name>`
is a new inventory citation, so a check that is a CI step, not a test
file, can be cited in TESTING.md.

**Ruled out:** excluding `unallocated_cash_cumulative` from MetricFlow
(the cumulative type covers it once its input is simple); a hidden helper
metric as the cumulative's input (it would sit in the manifest outside the
contract and break the set comparison's plain equality); `fill_nulls_with`
(silently ignored on this spec); the legacy `type_params` and measures YAML
(deprecated in dbt 1.12); comparing every spine month (future months carry
the cumulative balance and exist in no mart); a dbt singular test for the
comparison (dbt cannot run `mf`).

## 2026-10-30 — dbt docs are browsed locally, not hosted

**Chosen:** `dbt docs generate && dbt docs serve` on the throwaway fixture
database, documented in TESTING.md ("Browse the dbt docs locally"). Nothing
is hosted.

**Ruled out:**

- GitHub Pages: the repo is public, so the site would be public too.
- Cloudflare Pages behind Cloudflare Access: it works, but only after editing
  the Access apps Pages creates to cover the `<project>.pages.dev` host and
  adding a wildcard app. The Zero Trust free plan costs $0 for up to 50
  users but needs payment details on file, so one wrong click puts the
  under-$1/month constraint at risk. It also adds a CI deploy job, two
  secrets and generic setup docs to maintain.

**Why:** all of that is for about seven models whose contract already lives in
SEMANTIC_LAYER.md and `_marts.yml`. Real numbers belong in Phase 5 Grafana,
not in a docs site.

**Reconsider if** the model count grows a lot, or other people need to read
the models.

---

## 2026-10-30 — dbt runs on production nightly, names-only logs, one issue

`.github/workflows/dbt-nightly.yml` is the only thing that connects dbt to
production (Phase 4 PR-F). PR CI keeps the synthetic fixture.

- **Triggers.** `schedule` at 08:45 UTC and `workflow_dispatch`, nothing
  else. 08:45 UTC is after Toronto's midnight in EDT and EST, so the run
  sees the whole previous day; it is 30 minutes after eval-nightly (they
  share nothing) and off the top of the hour. Late and backfilled rows need
  no special timing: the marts are rebuilt in full every run.
- **Secrets stay off PR code.** `FINFLOW_DBT_HOST`, `FINFLOW_DBT_USER` and
  `FINFLOW_DBT_PASSWORD` are set on the three steps that connect, not on
  checkout or `pip install`, and the workflow has no `pull_request`,
  `pull_request_target` or `workflow_run` trigger. A first job checks the
  secrets are set (a job's `if` cannot read secrets); without them the
  build job is skipped and the run is green, so forks do not fail.
- **Main only.** The build job and both issue steps also require
  `github.ref == 'refs/heads/main'`, so a dispatch on a branch never runs
  that branch's models or tests against production. The secrets are
  repository-level, so in principle a workflow pushed to a same-repo
  branch could read them; only the owner and agents acting for the owner
  push here. The accepted control for this one-owner repo is that rule
  (`AGENTS.md`: dbt reaches production only in `dbt-nightly.yml`) plus the
  main-only gate, not a GitHub Environment with branch protection, which
  is an owner-level setting.
- **Connection.** Session pooler port 5432, `sslmode=verify-full` against
  the tracked public CA `supabase/prod-ca-2021.crt` (2026-10-28), given to
  libpq as `PGSSLROOTCERT` so dbt, `mf` and `check_metrics.py` all verify
  without a TLS setting in the profile or the script.
- **What runs.** `dbt build --exclude tag:fixture`: every model, invariant
  and the reconciliation to `public`, but not the fixture's hand-worked
  month. Then `mf validate-configs` and `check_metrics.py`. The
  `finflow_analyst` login check stays in the PR job: that role's password
  is not a CI secret.
- **Names-only logs.** The repo and its Actions logs are public. dbt's
  output carries row counts, failing-test counts and database error text,
  which can quote a row (a constraint error's DETAIL), so all of it
  (`dbt debug` included) and `mf`'s go to a runner file that is never
  printed or uploaded. The log says whether the connection worked and lists
  each node's status and unique id from `run_results.json`; `check_metrics.py`
  already prints names only and its stderr is withheld. Secret values are
  masked by GitHub and again with `::add-mask::`, and so is the project
  ref inside the user name.
- **Failure.** Adapted from eval-nightly: one open `dbt-nightly` issue,
  opened or commented on with a table of the failed node ids or checks and
  the run URL (never empty: a failed build with no failed node reads
  `dbt build | failure`); the next pass closes it. The connect, build and
  metrics steps have their own timeouts (3, 12, 4 minutes) under the job's
  25, and the issue step runs on `failure() || cancelled()`, so a hang
  still opens the issue; `check_metrics.py` connects with a 10-second
  timeout. The open issue is found through the REST issues endpoint,
  skipping pull requests, not `gh issue list`. `issues: write` and
  `GH_TOKEN` are scoped to the build job and its two issue steps.
  `AGENTS.md`'s read-first step checks the label.

**Ruled out:** any PR trigger with the secrets (fork PRs would reach
production); a dispatch from a branch running against production (its
edited models would write the production marts); printing dbt's log or
uploading `target/` (row counts and error text in a public log); secrets at
job level (pip's install scripts would see them); a
sslrootcert setting in `profiles.yml` and `check_metrics.py` (libpq's
environment variable covers all three tools); running the fixture test on
production (its literals describe the fixture).

---

## 2026-10-30 — The Data API roles are revoked, not fenced with RLS

A read-only check of production (2026-10-30) found RLS off on all 14 tables
in `public`, `anon` and `authenticated` holding USAGE on `public` and SELECT
on its tables (Supabase's default privileges), and the Data API answering.
Anyone with the project's anon key could have read the ledger through
PostgREST. Nothing in FinFlow uses the Data API: the Lambda, dbt and every
reader connect to Postgres directly.

**Chosen:** migration 0015 revokes, for each of `anon` and `authenticated`
that exists, every privilege on the tables, sequences and routines in
`public`; USAGE and CREATE on `public`, `staging` and `marts`; and the
migrating role's default privileges for them, in `public` (Supabase's
documented "Revoke default privileges" statements, securing-your-api) and
globally, since a per-schema revoke cannot remove a global default. It does
the same for `supabase_admin`'s defaults when the migrating role may; on
Supabase `postgres` may not, which is acceptable because every FinFlow object
is created by the migrating role. The migration fails if either role can
still reach a `public` table, and does nothing where the roles do not exist
(the throwaway test Postgres). The dbt test `data_api_roles_reach_nothing`
returns any grant, effective table or sequence access, routine grant or
default privilege either role holds there, names only; the nightly runs it on
production, so a grant Supabase or a later migration brings back opens the
`dbt-nightly` issue. The integration suite recreates Supabase's grants and
proves the revoke and the guard; the dbt CI job proves the guard fails as
`finflow_dbt`.

**Ruled out:**

- **RLS as the fix, or RLS with no policies as a second layer.** The readers
  `finflow_readonly` and `finflow_dbt` read `public` through grants, are not
  owners and do not bypass RLS. With RLS on and no policies they would see
  zero rows, not an error, so dbt would build empty marts and much of the
  suite would pass on nothing. Adding `using (true)` policies for each
  reader on every table, and remembering them for each new table, buys
  nothing while the Data API roles hold no grants.
- **Relying on the anon key staying secret.** It is a publishable key by
  design, meant to be shipped in clients; it is not in this repo, but that
  is not a control.
- **Only disabling the Data API in the dashboard.** It is a setting outside
  the repo that nothing here would notice being turned back on, and the
  grants would still be there. The owner should turn it off as well, as a
  second layer; the database does not depend on it.
- **Revoking `service_role` too, or PUBLIC's execute on new functions**
  (Supabase's fourth statement). `service_role`'s key is the secret key, not
  a public credential. The PUBLIC default is global, touches every schema,
  and `public` holds no functions.

**Reconsider if** FinFlow ever serves data through the Data API: then expose
a dedicated schema with explicit grants and RLS policies, not `public`.

---

## 2026-10-30 — Recurring series foundation: link, not flag; descriptions as word sets

Phase 4.5 PR 1, from the approved design (owner, with the five open
questions answered by their defaults). Migration 0016, three dbt tests,
`lambda/src/recurring.ts`.

**Chosen:**

- **`is_recurring` follows a link.** `transactions.recurring_series_id`
  with a composite FK `(recurring_series_id, type) → recurring_series (id,
  kind)`, `ON DELETE SET NULL (recurring_series_id)` (Postgres 15+), and a
  trigger: linking sets the flag, unlinking clears it, an unlinked insert
  keeps what it was given. Migration 0017 (after the owner's backfill)
  replaces the trigger with an exact rule and a CHECK. The contract
  formulas do not change; `fixed_base_burn` will rise as the backfill links
  real history, which is the point of the backfill, not a regression.
- **Numbering.** The design called the foundation 0015 and the later CHECK
  0016; 0015 went to the Data API lockdown, so they are 0016 and 0017.
- **`btree_gist` in schema `extensions`**, where Supabase keeps extensions,
  so its functions stay out of `public` and out of the Data API guard's
  view. Pauses never overlap by a GiST exclusion constraint.
- **Descriptions are word sets.** A real ledger logs one bill several ways
  (an extra word one month, the same item in different case, a bill logged
  under several word orders and wordings), most rows have no
  merchant, and some bills have one to three rows. So matching and
  detection normalise (merchant-key rules, then drop digits, month names
  and filler words such as "bill", "plan", "monthly"), and score two
  descriptions by the mean of their Jaccard index and overlap coefficient;
  0.6 or more is the same payment. An expense series matches on its name,
  its keywords and every description already linked to it, together with
  the amount (twice the band) or the date (window plus grace). The design's
  exact `descKey` (first two words) and whole-word keyword match are
  replaced by this. The detector groups unmerchanted expenses the same way,
  plus amount closeness, and a dismissed description key also silences a
  similarly worded group.
- **The name is a match key.** The design required an expense series to
  carry a merchant, a subcategory or a keyword; with description matching
  the name already is one, so that CHECK is dropped.
- **Thin history uses the declared cadence.** `recurring_series.cadence` is
  owner-confirmed and `NOT NULL`, so a bill logged once still has slots.
  `suggestCadence` only suggests a cadence once the history spans one full
  period of it ("not enough history, pick one" otherwise).
- **Gaps are missing payments.** Slots are calendar anchors fitted by capped
  L1 distance, never "last + 30 days": a month the owner did not log lowers
  coverage and counts as not logged, and cannot move the anchor or turn a
  monthly bill quarterly.
- **Proposal span.** The design's "span ≥ 2 periods" would never let a
  yearly series with its minimum of two payments be proposed; the rule is
  span ≥ (minimum payments − 1) periods less one tolerance, which is the
  same two months for monthly.
- **`nudge_runs` waits for the digest PR.** It belongs to the scheduled
  digest (PR 5), which adds its own migration; PR 1 holds no table nothing
  uses yet.

**Ruled out:**

- Grouping or matching by exact description, or by merchant alone: the real
  ledger defeats both.
- Edit distance (Levenshtein) on whole descriptions: word order and extra
  words ("Home internet plan" vs "Internet bill") dominate it.
- Stemming or a synonym list ("metro" = "public transport"): a dependency or
  a maintained list for a gain the linked-description references already
  give; reconsider if real misses trace to it.
- Enabling RLS on the new tables: it would hide them from `finflow_dbt`
  (DECISIONS 2026-10-30, grants are the boundary).

**Reconsider if** the review screens show many weak or missed matches on real
history: tune the 0.6 threshold or the filler-word list first.

## 2026-10-31 — The /recurring menu: stateless screens, writes only on labelled taps

Phase 4.5 PR 2, from the approved design (§D, §E, §H PR 2).

**Chosen:**

- **Every tap re-reads the whole recurring book** (series, every
  transaction with its largest line's subcategory, pauses, skips,
  exclusions, dismissals: a few hundred rows) and derives windows, bands,
  candidates and proposals in `recurring.ts`, as the design's "derive, never
  cache" rule says. `matchStrength` fits a history once per screen rather
  than once per row, and `tokens()` remembers word sets, which took a
  synthetic 520-row, 25-series list from about 950 ms to about 90 ms.
- **Nothing is written until a tap whose label says what it writes.** The
  last step of a pause, Resume, Delete (after a confirm screen), a cadence
  on the add screen, Apply (`✅ Link 5 · ignore 3`, rewritten on every
  toggle), Clear flag on ticked (k) and Not recurring. Toggles, Select all,
  Amount varies and Later edit only the keyboard, the mention review's
  pattern (DECISIONS 2026-10-29). Every write is one SQL statement.
- **A repeat finds the work done and only pops up.** A double tap or a
  Telegram retry gets "Already paused/applied/cleared/…" and no edit, so it
  never redraws over the screen the first tap left (and the journey fakes
  refuse an edit that changes nothing, as Telegram does).
- **Typed pause end.** Besides "until resumed" and one or three months on,
  a pause can end on a date the owner replies with (ForceReply, the
  prompt's text carries the series id and start date, so no waiting state),
  a yearless date on or before the start meaning next year's. This is how
  a series that bills again only from a known later date (a free trial, a
  paused plan) is told not to expect a payment before then; a new series'
  review offers it directly (`⏳ Next payment not until…`).
- **Legacy flags get ➕ per row** rather than one "Make a series from …"
  button whose target would depend on which row is ticked, plus Select all
  and paging (`r:f:<offset>`); the list starts unticked, because clearing a
  flag is the owner's call.
- **`r:b` with no series** opens the first series with candidates, else the
  legacy flags (the design's "when no series has candidates left").
- **The add flow stores no keywords**: the name is already a match key
  (DECISIONS 2026-10-30). A default name another series has gets a number.
- **The review's totals come from the database** (`N payments linked, M
  ignored`), not from counts carried between pages, so they stay right
  across pages and retries.

**Ruled out / deferred:**

- **A series with a future start and no payment yet.** The schema has no
  start date, and a series' expected payments start at its first linked
  payment, so a series with none expects nothing; the add flow also starts
  from a saved payment. Expressing "first bill on Dec 15" with no history
  needs a `starts_on` column (a migration this PR does not add). Until then
  the owner adds such an item from its first payment once it posts (PR 3's
  Saved reply offers that), or, when it has history, pauses it until the
  date it bills again.
- Button colours (`style`), the digest's silent send, and the detail's
  "Matches:" line: not needed by the menu; the digest PR adds
  `disable_notification`.
- A candidate can be offered under two series; it joins whichever Apply
  links it first and then leaves the other's list (links are never stolen).

**Reconsider if** a tap feels slow on real history: the book is read whole
on every tap; an index-backed candidate query is the next step.

## 2026-10-31 — A /recurring prompt never takes an expense; "today" means the tap's day

Code review of PR #87 (Phase 4.5 PR 2).

**Chosen:**

- **Logging an expense wins over a prompt** (hard constraint 6). Only a
  text reply to the bot's own rename or pause-end prompt, sent within 15
  minutes of the prompt (`message.date − reply_to_message.date`), is taken
  as the answer. A photo, voice note, audio, document or caption, an empty
  text, a reply to anything else or a stale prompt goes on to extraction.
  Text with money in it (a number with a decimal part, such as 12.50 or
  4,50, or a currency marker next to a number: $5, 5$, 5 dollars) is an
  expense whichever prompt it answers, so "lunch 12.50" replying to a
  rename prompt is saved, not taken as a name; plain digits in a name
  ("Internet 2", "Gym 24") still rename. A date reply that is no date but
  reads as an expense (a number next to a non-date word, "coffee 5") also
  goes to extraction; only an unmistakable attempt gets the "try again"
  reply. A name such as "Plan 2.0" would read as money; it can be typed
  without the decimal.
- **A typed pause end with no year is its next occurrence** after the
  later of the pause's start and today, not the most recent past one; a
  day not after the start (today, yesterday, an earlier date) is refused.
  Dates outside the current year show their year.
- **"Today" buttons carry `t`**, resolved to the Toronto day of the tap, so
  a menu tapped days after it was drawn resumes or pauses on the right
  day.
- **Racing double taps answer as repeats.** A create that waited on
  another tap's create reads the series name in a second statement; a
  pause that hit the exclusion constraint re-checks for the identical
  pause and says "Already paused".

**Ruled out:** a stored "awaiting prompt" state (the Lambda stays
stateless; the prompt's own text and date carry everything needed), and
undoing a review exclusion from the menu (logged as a follow-up; the spec
makes an unticked shown row ignored for good).

## 2026-10-31 — The card proposes the series; Gemini's recurring guess is a hint only

Phase 4.5 PR 3 (`feat/recurring-card-link`), design §E.6 and §D.3 P1.

**Chosen:**

- **The card proposes the strongly matching series by default** (owner
  decision): `Recurring: <series>` on the card and a last row
  `↻ <series> ✓`; Confirm (`cr:<card>:<series>`) links. Turning it off is
  one tap that only edits the keyboard (`↻ not <series>`, Confirm becomes
  `cx:`), and Confirm then records the exclusion, so the payment is never
  offered to that series' review again. Off by default would add a tap to
  every recurring payment and recreate the "3 of 4 linked" gap. A weak
  match is not proposed; the review shows it. Only a card that can be
  confirmed is matched (a dateless card is matched when its date arrives).
- **Outside the band is one note line** (`↻ Phone bill · usually 45.00;
  this is 61.25 (+16.25)`), never a block.
- **Confirm never fails because of the link.** It re-reads the series
  inside its own transaction with `FOR KEY SHARE` (a concurrent delete waits
  for Confirm, or wins first and leaves no row) and re-checks kind and hard
  key (income source, accounts; the same predicate as the review's Apply).
  A series gone or no longer fitting saves the payment unlinked, and the
  reply says `Not linked: that recurring series is gone or no longer fits.`
  A double tap is the existing ingestion lock: the second says "Already
  handled." and links nothing.
- **Gemini's `is_recurring` is no longer saved.** New rows are recurring
  exactly when linked, so the legacy-flag list only shrinks and migration
  0017 can ship after the backfill. The guess is still extracted (prompt
  unchanged, no golden churn) and is used only when no series is linked:
  the card reads `Recurring: not tracked yet` instead of `no`, and the
  `Saved.` reply gets `↻ Track as recurring` (`r:at:<transaction>`), which
  opens the add flow. That is also how a series with no history is
  declared at its first charge. Payments Gemini did not call recurring are
  tracked from `/recurring` → ➕ Add, so most Saved replies stay plain.
  Expect `fixed_base_burn` to count a new recurring payment only once its
  series exists.
- **The card change is isolated** for the coming card redesign: one line
  (`formatPreview`'s `series` argument), one note line, one button row
  (`reviewKeyboard`'s `series` option, `toggleCardSeries`), matching in
  `lambda/src/recurring-card.ts`.

**Ruled out:** the Track button on every unlinked Saved reply (a button
under every grocery receipt; `/recurring` → ➕ Add covers what Gemini
misses), still saving Gemini's guess on unlinked rows (it would keep
growing the legacy-flag list and block 0017), re-running the matcher at
Confirm (Confirm links exactly what the card showed; a changed series is
caught by the re-check), and storing the toggle server side (the keyboard
holds it, as on the review).

## 2026-10-31 — The residual rate is `unspent_rate`, not a savings rate

- **`savings_rate` is renamed `unspent_rate`.** It measures money not
  spent, `(income − spend) / income`, not money moved into a savings,
  investment or debt account. The view follows 50/30/20, where the 20%
  counts only money actually moved; calling the residual a savings rate
  would read as that 20% when part of it may still sit in chequing
  (`unallocated_cash`).
- **The formula is unchanged:** `round((income - spend) / nullif(income, 0), 4)`,
  null when income is `0`. Renamed in the contract, the
  `fct_monthly_summary` column, MetricFlow, `check_metrics.py` and the
  dbt tests. No dashboard reads the column yet (Grafana is Phase 5).
- **The 2026-10-29 metric-contract entry is superseded in name only;** its
  reasoning about a residual rate stands.

**Ruled out:** keeping `savings_rate` and adding the moved-money rate under
another name (the familiar name would stay on the wrong number).

## 2026-10-31 — Debt is an account kind; extra payments are transfers into it

Debt support is built ahead of need, for anyone who forks the repo with a
mortgage or a car loan.

- **`accounts.kind` gains `debt` (migration 0017).** An extra payment on a
  loan is a transfer from chequing into a debt account, the existing deposit
  shape, so it reaches `transfers` with no new metric and `account_kind`
  splits it out. A minimum payment stays an ordinary `needs` expense line in
  the loan's subcategory (Mortgage, Car loan payments, Student loans,
  Personal loans already exist). Paying a loan from savings is a move
  between two accounts, in no metric: net position is unchanged.
- **A debt account only receives transfers, guarded by a dbt test, not a
  constraint.** `debt_account_only_receives_transfers` fails on a transfer
  from a debt account (a drawdown, out of scope) and on an income source
  whose deposit account is a debt account (it would put a loan inside
  `savings_income`). A CHECK cannot read `accounts.kind` from another table,
  and a trigger is more machinery than one ledger invariant needs; the
  dbt-nightly run catches it the next morning.
- **The bot needs no change.** It lists every account by name and Gemini's
  prompt names no kind, so a debt account is a normal transfer destination.

**Ruled out:** debt as a spend bucket (`bucket = 'financial_future'`: it
would break the meaning of `spend` and needs plus wants equals spend),
balances or interest on a debt account (the ledger has no balances), and a
golden case for a debt transfer (the suite is capped at 20; a journey with a
neutral "Car loan" account proves it).

## 2026-10-31 — Financial future is money actually moved; 50/30/20 targets per person

The view follows 50/30/20: needs, wants and "financial future" (saving,
investing, paying a loan down faster) as shares of the month's income.
`unspent_rate` counts money not spent, which includes cash still sitting in
chequing that can leak into next month's spending, so it is not the 20%.

- **`financial_future = transfers - withdrawals`: money actually moved.**
  Money counts only once it is in a savings, investment or debt account.
  Cash left in chequing is `unallocated_cash`, shown as its own line ("still
  in chequing"), not financial future.
- **`unspent_rate` is kept** (renamed from `savings_rate` the same day): it
  is the standard savings rate, just not the 20% line.
- **The base is `spendable_income = income - savings_income`.** Savings
  interest is growth inside the account, so it is neither income nor
  financial future in this view. Refunds and other income count.
- **A withdrawal lowers that month's financial future.** No carry-over: the
  owner dates a late transfer to the month it belongs to, so the transfer's
  `occurred_on` is enough.
- **Debt reaches it through the existing deposit shape.** An extra loan
  payment is a transfer into a `debt` account (migration 0017), so it is in
  `transfers` and `financial_future` with no separate debt term; a minimum
  payment stays `needs` spend.
- **Targets are per person, in a one-row `budget_targets` table**
  (migration 0018), stored `0`-`100`, seeded `50/30/20` (nothing personal),
  overridden in the untracked seed overlay, exposed to the marts as
  fractions. No effective dates: a change restates history, as other
  settings do. Which direction is better is not encoded; Phase 5 colours it.
- **The identity `spendable_income = spend + financial_future +
  unallocated_cash` holds exactly** by construction and is a dbt test, as is
  the four shares summing to 1 within rounding.

**Ruled out:** carrying a shortfall into the next month (late transfers are
dated to their month); deleting the old savings rate (kept, renamed);
counting savings interest as income or as financial future (it is growth);
debt as a spend bucket (`bucket = 'financial_future'` would break `spend`
and the identity); percentages of spend instead of income (the owner wants
share of income); per-month target history; a cumulative financial-future
metric; a Telegram command or card for this view (Phase 5 charts the mart).

## 2026-11-01 — The daily digest: what rings, what retries, what a button may write

Phase 4.5 PR 5 (design §E.3, §F). Choices the design left open:

- **Any answer from Telegram that is an error is a definite failure**
  (HTTP 4xx or 5xx, or `ok: false`): the run is `failed` and Lambda's
  asynchronous retry (the Scheduler invokes asynchronously) claims it
  again. Only a send with no answer (timeout, reset, a thrown fetch) is
  ambiguous and stays `claimed` forever. A 5xx could in theory have
  delivered; the design's rule is "Telegram answered with an error", and a
  rare duplicate on a Telegram outage is accepted.
- **Each chat runs on its own.** A digest that cannot be built after the
  claim is `failed` like a refused send, the other chats still get theirs,
  and the function throws only after the loop. Recording `failed` is best
  effort: if the database is gone the row stays `claimed` and the day is
  lost, like an unanswered send.
- **"No digest on <day>" needs an earlier run.** It shows when yesterday
  has no run, or a `failed` one, and some run exists before yesterday, so
  the very first digest after the deploy notes nothing. A `claimed`
  yesterday (outcome unknown) is not noted, even one a database failure
  left there: it cannot be told from a send that may have arrived, and a
  "may not have arrived" note was weighed and left out (2026-11-02
  review). The footer alone is not content: a day with nothing else to say
  still sends nothing.
- **The counts are content.** A day whose only news is "🧹 3 past payments
  look like …" or "🔎 1 possible new recurring item" is still sent
  (silently), as open question 1's default says; it stops once reviewed or
  dismissed.
- **Income and varying amounts have buttons too.** They never ring until
  not logged, but Find and Skip are offered on every due and not-logged row,
  as in the design's keyboard mock.
- **Not logged is newest first**, 10 shown, the rest in an expandable quote.
  Every list is cut from its end to keep the message within 3,500 visible
  characters, each with "+N more in /recurring": the folded not-logged rows
  go first, then Coming up (no buttons), then the shown not-logged rows,
  Due now last. Too long a message is refused by Telegram every retry.
- **A digest redraws for its own day** (`nudge_runs.run_date`), from the
  database as it is now, so yesterday's digest tapped today keeps its
  header and shows today's links and skips.
- **Undo shows only for a skip recorded on or after the digest's day**
  (`recurring_skips.skipped_at`, Toronto). The app writes `skipped_at` from
  its clock, not `now()`, so tests with a fixed clock agree with Postgres.
  An older skip is just a settled payment and is not listed.
- **Skip re-checks at tap time.** It writes only when the payment it names
  is still due or not logged; a payment logged since, an earlier skip, a
  pause or a deleted series answers why and writes nothing. Skip and Undo
  act only on a message that is a digest the bot sent (`nudge_runs` by
  chat and message); Find writes nothing and works on any message.
- **Find adds `‹ Back to digest` (`r:dv`)**, not in the design's scheme:
  without it the digest message is lost once Find replaces it.
- **Digest taps live in `recurring-digest.ts`**, parsed by `parseDigestTap`
  just before `parseRecurringTap` in `handleCallback`, so the menu module
  does not import the digest (no import cycle).

**Ruled out:** a dead-letter queue or a second schedule to "catch up" a
lost day (the next digest recomputes everything); retrying an ambiguous send
(a duplicate is the nag the owner asked to avoid); writing a skip from a
stale button without re-deriving the slot (it could settle a payment the
owner logged meanwhile).

## 2026-11-01 - Duplicate warning also sums parts

**Decision:** an expense card also warns when 2 or 3 earlier entries of the
same type, each within 1 day of its day, add up exactly to its amount.
Closes the gap where a receipt's items were typed one by one and the receipt
total then matched no single entry.

- **Warning only, one line.** `! may repeat 2 earlier entries around <date>
  that add up to this total`; Confirm stays, nothing is stored, no Gemini
  call, no migration, and a failed check still sends the card.
- **Exact numeric sum, bounded.** Candidates are saved transactions and the
  chat's open cards (never the card's own update, never discarded), nearest
  day first, capped at 12; a pair is preferred to a triple. A photo match
  and any single-amount match still come first.
- **Expenses only for now.** Income and transfers are not summed: they are
  rarely typed in parts.

**Ruled out:** a "replace the earlier entries with this receipt" button (needs
its own design); a wider window or more than 3 parts (more false hits on
ordinary same-day purchases); summing in floating point.

## 2026-11-02 - Card warns about an implausible date

A receipt printed `26/09/22` (year/month/day) beside a footer `2026-09-22`; the
lighter model read it day/month/year, the card showed a 2022 date, and the
purchase was confirmed and dropped out of the right month. Nothing on the card
looked wrong.

- **Warning only, one line, deterministic.** `! date <date> is in the future:
  check it` (later than tomorrow, Toronto), `is more than a year ago: check
  it` (before today minus 12 calendar months), or `is before your oldest saved
  entry (<date>): check it` (over 31 days before the oldest saved transaction,
  on a card over 90 days old). Confirm stays; no Gemini call, no migration.
- **Same render path as the duplicate warning.** Computed in `sendCard`, so
  first card, Fix date, Edit and `/pending` all show it. A failed lookup of
  the oldest entry drops only that last check.
- **Tomorrow is allowed**, for a late-night purchase; thresholds are named
  constants in `extraction.ts`.

**Ruled out:** rejecting such a date (a real old receipt is legitimate; the
owner decides); fixing the misread in the prompt (separate change); a stricter
window than 12 months (backfilling a few months is normal).

## 2026-11-02 - Ledger health tests in the nightly dbt build

The owner found by eye a row dated 2022 (a misread receipt date, the only one
before the ledger start), one payment entered twice a day apart, and a row
flagged recurring with no series. Nothing in the pipeline flagged them.

- **The ledger start is a dbt var, `ledger_start`, default `2026-06-01`**
  (the import scope of 2026-08-13). `occurred_on_within_ledger` fails, as an
  error, any row before it or after Toronto's tomorrow. It replaces the
  warn-only `occurred_on_not_in_future`: a date outside the window always
  drops the row out of its month, so it is a bug, not a signal. The
  synthetic fixture starts in March, so `test_db.py` exports
  `FINFLOW_LEDGER_START=2026-03-01`; production never runs that script.
  A genuine purchase older than the start must be dated inside the ledger or
  the start moved here.
- **Likely duplicates and recurring flags with no series are warnings.**
  The ledger can hold a real repeat, and one unlinked recurring row is a
  known leftover. A pair needs the same type and amount, at most 3 days
  apart, and descriptions equal once case and all whitespace are dropped;
  different descriptions at one price (two tickets, a washer and a dryer)
  are never listed. All types, not only expenses, since a doubled income or
  transfer skews the month the same way.
- **Warnings surface in the job summary and one rolling issue labelled
  `ledger-health`**, test names, counts and ids only.
  `scripts/ledger_health.py` reruns the two id-only tests inside the build
  step, which already holds the secrets, and withholds any value that is not
  a UUID. The issue body is rewritten, with a comment, only when the findings
  change, so a standing leftover does not notify every night; a clean,
  successful build closes it.

**Ruled out:** failing the nightly on warnings (the known leftover would keep
it red); `--store-failures` for the ids (it creates an audit schema
`finflow_dbt` may not create); fuzzy description matching (more false pairs
than the cases seen so far justify).

## 2026-11-02 - Venue and printed-date rules in the extraction prompt; tax and tip allocation moves to code

Two production cards were wrong in ways the prompt allowed: a discount store
got the nearest venue on the list, and a receipt's `YY/MM/DD` date was read
as `DD/MM/YY` (years in the past). A third had tax spread over every line
when the receipt taxed only one.

- **Venue.** A venue is set only when the place clearly is one of the
  listed venues. A dollar, discount, hardware, department, online,
  rideshare or warehouse store is none of them and gets null; the nearest
  venue is never picked.
- **Printed date.** A 4-digit-year date (often a footer timestamp) beats a
  2-digit `NN/NN/NN` one. An `NN/NN/NN` alone is read so that it falls in
  the 12 months before today, as year/month/day when day/month/year would
  land years away. No date more than a year from today unless the message
  says so. The card's implausible-date warning (#106) stays the
  deterministic backstop.
- **Where they live.** Shared constants `VENUE` and `DATE_READING` in
  `lambda/src/gemini.ts`, in the text, photo, voice and Edit prompts; not
  the owner's needs/wants rules (`rules_sha256` hashes those; they are
  personal and live in SSM). Both passed the live eval under
  gemini-3.5-flash-lite.
- **Tax and tip allocation moves to deterministic code, in a separate PR.**
  A prompt rule (tax only on the lines a receipt flags as taxable, the tip
  by each line's pre-tax price) was tried here and removed before merge:
  under gemini-3.5-flash-lite the synthetic receipt's lines came back
  3.50 / 12.25 on one run and 3.90 / 11.85 on the next, never the expected
  3.60 / 12.15. This removes a rule that does not reliably work under the
  lighter model; it does not loosen an assertion. `LINE_AMOUNTS` stays as
  it was (2026-08-13, 2026-10-29) until the code step lands.
- **Goldens stay at 20.** `receipt-with-tip` now prints a `YY/MM/DD` date
  and a 4-digit-year footer and checks the date and that a diner has no
  venue; `two-stores` checks no venue for a dollar store and Pharmacy for a
  pharmacy.

**Ruled out:** tax and tip allocation by prompt alone (inconsistent splits
under Lite, above); a new golden case per rule (the suite is at the free
tier's 20 a day).

## 2026-11-02 — Waiting prompts: Keep as is; `/pending` includes waits

A card in `awaiting_date` / `awaiting_edit` only had Discard to leave the
wait (menu-exit audit item 1). Photos and voice while waiting are still
not read (2026-08-18 / 2026-09-08). `/pending` listed `pending` only, so
a lone waiting card answered "No pending cards."

- **Keep as is.** Both wait prompts carry `Keep as is` + `Discard`
  (`k:<uuid>` / `d:<uuid>`). Keep as is sets status back to `pending`
  without changing the extraction and resends the Confirm card (no Gemini).
  Double-tap is idempotent ("Already handled."). Confirm still requires
  its own tap.
- **No Fix date on the date prompt.** The old keyboard reused
  `reviewKeyboard({ confirm: false, edit: false })`, so Fix date while
  already waiting said "Already handled." (audit item 2).
- **Way back on errors.** A non-date reply, a photo/voice while waiting,
  a date or correction that fails checks, and a Gemini failure on Edit
  attach the same Keep as is / Discard keyboard (audit item 3).
- **Busy copy.** Points at Keep as is / Discard on the waiting prompt,
  not at the retired card (audit item 8).
- **`/pending`.** Lists `pending`, `awaiting_date` and `awaiting_edit`.
  A waiting row is resent as its wait prompt (status unchanged); Keep as
  is is the exit that restores `pending`. Pending rows still get
  `sendCard`.

**Ruled out:** `/pending` auto-restoring awaiting → pending (would cancel
an intentional Fix date / Edit); full stale-tap wording (#92); card
redesign batch.

## 2026-11-07 — `is_recurring` is exactly the series link (migration 0020)

The owner's backfill is done, and a read-only production check found no
row flagged recurring without a series and none linked without the flag.

- **CHECK, trigger kept.** 0020 adds `CHECK (is_recurring =
  (recurring_series_id is not null))` and keeps 0016's trigger as it is.
  Updates still derive the flag from the link and a linked insert is still
  marked recurring, but an unlinked insert flagged true is refused, not
  silently cleared: a caller that still writes a guess fails loudly.
- **Legacy-flag screen removed.** The `/recurring` screen that listed
  flagged rows with no series, its counter, the review's ⚑ pre-tick and
  `clearFlags` existed to empty that list before this CHECK. With the CHECK
  they can never show anything, so they go in the same PR; their old
  buttons read as nothing.
- **dbt test kept as a mirror.** `recurring_flag_has_series` (warn, one
  direction) becomes `recurring_flag_matches_series` (error, both
  directions). It can only fail if a later migration drops the CHECK; it
  stays for that, as `expense_funding_rules` mirrors 0007's CHECK.

**Ruled out:** replacing the trigger with an unconditional
`new.is_recurring := new.recurring_series_id is not null` (the plan in
DATA_MODEL.md before this; it would make the CHECK unreachable and hide a
bad write); deleting the dbt test as redundant (loses the nightly guard
against the CHECK being dropped); keeping the legacy-flag screen as dead
code (its tests can no longer seed a row).

## 2026-11-07 — Not-a-duplicate acknowledgements live in the database (migration 0021)

The owner reviewed the 35 pairs `no_likely_duplicates` reported (#109):
34 were real separate payments (same-day tickets, laundry machines, fares)
and one was a true duplicate, since removed. A warn test that keeps listing
pairs already ruled on can never go clean, so the rolling issue can never
close.

- **A table, `duplicate_acknowledgements`.** One row per unordered pair
  (`first_id < second_id`, primary key on both), each a foreign key to
  `transactions` with `ON DELETE CASCADE`, so deleting either row drops the
  acknowledgement and an id never dangles. The test excludes a pair with a
  `NOT EXISTS` on it.
- **In the database, not the repo.** The repo is public: a seed or YAML
  list of acknowledged ids would publish transaction ids next to the
  reason they were ruled on.
- **An owner-run SQL snippet, not a bot command.** The ledger-health
  surface is a GitHub issue, not a Telegram screen, so there is no button
  to attach one to. A `/notdup` command would add a handler, parsing, tests
  and a journey for a task done a few times a month. The snippet
  (TESTING.md, "The nightly dbt build") takes the ids in either order.
- **Grants by default privilege.** `finflow_dbt` and `finflow_readonly`
  read it through 0003 and 0013; `finflow_analyst` reads marts only; the
  Data API roles get nothing (0015, `data_api_roles_reach_nothing`).

**Ruled out:** acknowledged ids in a tracked file (public); a Telegram
command or button (no surface to attach it to, more code than the task
earns); marking the transactions themselves (a flag on one row cannot say
which pair it was cleared from).

## 2026-11-07 — A separate warn test for one payment logged under two descriptions

One receipt was confirmed twice weeks apart, titled by its merchant the
first time and by its items the second (#114). `no_likely_duplicates`
requires matching descriptions, so it never listed the pair.

- **A second test, `likely_duplicates_reworded`,** not a looser first
  one: the same type and amount at most 1 day apart with descriptions that
  differ. Kept apart so a pair whose descriptions match (most likely one
  payment) stays distinguishable from two real purchases at one price.
  1 day, not 3: a re-logged receipt keeps its printed date.
- **Quiet by design.** The post-backfill audit found 28 pairs of this
  shape, about 24 of them imported rows: fares and laundry machines from
  the history. Left out are pairs under 3.00 where both rows were imported
  (no confirmed ingestion), pairs in one recurring series, and acknowledged
  pairs (migration 0021). An under-3.00 pair with a bot-logged row is still
  listed, so an import the bot logged again under another description shows.
- **Warn only, ids only,** like `no_likely_duplicates`; `ledger_health.py`
  lists its pairs in the same issue.

**Ruled out:** fuzzy description matching (cannot tell a merchant name from
an item summary); a perceptual hash of receipt photos (code and storage
for one case so far; #114 keeps it as an option); blocking Confirm on an
amount match (adds a step to logging, AGENTS.md rule 6).

## 2026-11-07 — Tax and tip are shared across the lines in code, not by the model

The prompt rule (2026-10-29) asked Gemini to fold tax and tip into the
lines. Flash-Lite split them unevenly. On an Edit it also added a corrected
tip on top of the old one (#60). The 2026-11-02 attempt at a taxable-lines
prompt rule gave a different split on every run. Arithmetic now moves to
code. The model only reads numbers.

- **What Gemini returns.** Each line's pre-tax `price` (after any discount
  on that line) and `taxable`: true when the receipt's tax codes mark the
  line as taxed. When the codes mark the untaxed lines instead, the
  unmarked lines are the taxed ones. Also `taxes`, each tax amount as
  printed (GST and QST are two entries), and `tip` (or null). The header
  `amount` is still the total paid, tax and tip included. There is no tax
  or tip line, and the response has no per-line amount.
- **What code does** (`lambda/src/tax-tip.ts`, integer cents). The taxes
  go to the taxed lines, or to every line when none is marked. The tip goes
  to every line. Both are weighted by pre-tax price and rounded with
  largest remainder (ties: the larger line, then the earlier one). The lines
  sum to prices + taxes + tip exactly and are never below their price.
  `transaction_items.amount` is that allocated amount. The extra fields
  ride in `ingestions.extraction` jsonb, so there is no migration.
- **Checks unchanged.** When prices + taxes + tip differ from the printed
  total, the existing line-sum check fails and the card has no Confirm. The
  difference is never absorbed into the lines. A tax or tip that is not
  two-decimal is an error.
- **Edit.** The patch request sends the parts (prices, taxable flags,
  taxes, tip), not the allocated amounts. The prompt says a new tip or tax
  replaces the old value, and to keep `amount` unless the correction states
  a new total. When the patched `amount` equals the current one, the header
  becomes the sum of the recomputed lines. A total the model changed stands,
  and the line-sum check judges it, so a tip added on top fails visibly.
- **Cards look the same.** Header, lines and `✓ lines a + b = total` keep
  their layout, with no tax or tip row. Only line amounts can differ, when a
  receipt taxes some lines and not others.
- **Goldens.** The judge (`golden.ts`) reads a raw answer through the same
  `lineAmounts` and Edit-total rule. A new optional `amounts` pins each
  line: `receipt-with-tip` (Quebec GST + QST diner, tip below the total)
  and `edit-tip`. The suite stays at 20 cases. A synthetic Quebec grocery
  receipt, with a zero-rated line and a taxed one, is covered by unit tests
  and a journey with a scripted answer, not a golden.
- **A card pending at deploy time** has no prices. Its line amounts are
  sent as prices, with no taxes and no tip.

**Ruled out:** absorbing a header mismatch into the lines (it would hide a
misread price); deriving every header from the parts (a total the owner
states in an Edit would be ignored); per-tax taxable flags for lines taxed
by GST only (rare, and a bigger schema); a second Gemini call (free-tier
quota).

## 2026-11-07 — The current month is planned in dollars from an expected income

Phase 5's "This month" dashboard needs a plan for a month still in
progress. The contract's `*_pct` shares divide by `spendable_income` so
far, and income lands mid-month and at month end, so early in a month a
share can pass 100% and it halves when pay arrives. They stay right for
complete months only.

- **A dollar plan from an expected income** (`fct_month_plan`): a
  complete month expects its actual `spendable_income`; the current month
  expects `greatest(income so far, mean spendable_income of the up-to-3
  complete months before it)`, and nothing when there is no such month.
  Plans are `target_pct × expected`. Month-to-month income varies little,
  so the estimate is close; `greatest()` follows a one-off rise at once.
  The final read of a complete month equals the share view.
- **Pace from the owner's own timing** (`fct_pace_day`): "usual by this
  day" is the mean of the baseline months' month-to-date at the same day
  of month, because rent and paydays fall on fixed dates. The last day of
  a month matches the last day of each baseline month, so a 30-day month
  still closes at the baseline months' totals.
- **Subcategory baselines zero-filled** (`fct_subcategory_month`): a mean
  over the months a subcategory appeared in would run high.
- **Planning marts, not metrics.** They are a section of SEMANTIC_LAYER.md
  with formulas and reference SQL, like the Recipes. The metric table must
  equal the MetricFlow YAML, and MetricFlow cannot express "complete
  preceding months only", so `fct_monthly_summary`, the metric table and
  MetricFlow are unchanged.
- **A fixed `today` for the fixture.** `toronto_today()` reads the dbt var
  `today` (environment `FINFLOW_TODAY`) when set. The fixture pins it to
  2026-10-15 so its October is a current month with a baseline; production
  never sets it.

**Ruled out:** shares of income so far for the current month (wrong before
payday); prorating the plan by calendar day (about half a month's spend
lands in its first week, so it would read "over" every first week); an
owner-set expected income in `budget_targets` (goes stale silently; kept as
the fallback if the estimate proves wrong); the plans as MetricFlow
metrics.

## 2026-11-08 — An Edit recomputes its total only for a tip or price correction

A review of #118 found two ways the Edit total rule (2026-11-07) could
silently show a wrong total with a check mark:

- **Cards stored before prices.** Their line amounts already hold the tax
  and tip, and they are sent as prices with no tip. A tip correction then
  counted the tip twice: a 50.00 card with a 5.00 tip, corrected to an
  8.00 tip, showed 58.00. Now such a card always keeps its stored total.
  The parts fail the line-sum check, and the owner sees an error card with
  nothing saved.
- **Unrelated corrections.** Any Edit that left the total alone took the
  recomputed line sum. A date Edit that came back with one of two taxes
  dropped therefore moved 24.52 to 23.82. Now the line sum replaces an
  unchanged total only when the taxes and the number of lines match the
  current card, the tip was not removed, and the tip or a line's price
  changed. Every other difference keeps the stored total and fails the
  line-sum check.

The rule is narrower than "recompute when tip, taxes or prices differ". In
the dropped-tax case the taxes do differ, so that rule would still have
recomputed. A tax correction that leaves the total alone now gets an error
card, and the owner states the total.

**Ruled out:** inferring from the correction text which field it targets
(another model judgement in the money path).

## 2026-11-08 — Keep `transfer`; retire `no-date-text` to free a golden slot

The 20-case cap stays (the eval project's free Flash quota). A new case
needs a slot, and two looked redundant.

- **`transfer` stays.** It is the only case where Gemini reads a deposit:
  money moved from chequing into an account (`from_account` null,
  `to_account` set), the most common transfer. `transfer-withdrawal` covers
  a withdrawal (from an account to chequing) and a move between two
  accounts, never a deposit. A deposit read as coming from "chequing" (not
  an account) would lose Confirm, and only `transfer` would catch it live.
- **`no-date-text` goes.** It checked that a dateless text leaves the date
  empty and adds no note. `no-place-lines` ("12 lunch and 4 coffee") is also
  a dateless text with no reason, and its recording already satisfied both
  checks, so it now asserts `date: false` and `note: false`. The
  dateless-text journey replays it. `receipt-no-date` and `voice-note` still
  check a missing date on a photo and a voice note.

**Ruled out:** raising the cap (more Lite answers on busy days; see the
2026-11-07 eval-cap research); retiring `transfer` (above).

## 2026-11-08 — A discount on the whole order is its own list, shared by price in code

After #118 the prompt allowed a discount only on one line ("pre-tax price
... after any discount on that line"). A receipt with a coupon off the whole
order then had prices that summed above the total: the line-sum check
failed and the card had no Confirm. Before #118 the model folded the coupon
into the line amounts itself, so this was a friction regression.

- **What Gemini reads.** `discounts`: each discount on the whole order (a
  coupon, a member or loyalty discount, a percentage off the subtotal) as
  a positive amount, an empty list when none. It is never a line and never
  taken off a price. A receipt prints it as `-5.00`; the bot ignores the
  sign (`discountsOf`), so a model that copies it still gets Confirm.
- **What code does** (`lineAmounts`, integer cents). The discounts come off
  every line by price, with the same largest-remainder `allocate`. The
  taxes then go to the taxed lines (all lines when none is marked) and the
  tip to every line, both by discounted price. Lines sum to prices -
  discounts + taxes + tip exactly and are never negative. When the
  discounts exceed the prices, the prices stand and the line-sum check
  fails.
- **Taxes stay as printed.** A store coupon lowers the taxed base, and the
  printed GST and QST already reflect that, so code never recomputes tax.
- **Edit.** The patch request sends the discounts with the other parts. A
  corrected or added discount counts as a tip or price correction does
  under the 2026-11-08 Edit total rule: the total follows the recomputed
  lines unless the correction states one. A discount the model drops keeps
  the stored total, like a dropped tip, and the line-sum check fails it.
- **No golden yet.** Recording one needs a new synthetic receipt and a live
  Gemini call. The slot `no-date-text` freed is still open (19 cases), so a
  `receipt-order-discount` case fits under the 20-case cap. Until then unit
  tests and the `tax-tip` journey script the coupon.

**Ruled out:** a discount line (the taxonomy has nowhere for one and the
ledger would hold a negative line); putting the whole discount on the
largest line (it shifts the needs/wants split); sharing the discount over
the taxed lines only (a coupon is off the order, not off the taxed goods).

## 2026-11-08 — A machine cycle has no goods item type: a prompt rule, not a code guard (#89)

The overload fallback model gave a laundromat washer cycle `Housing /
Laundry / Laundry Supply`; the main model answered `Housing / Laundry` with
no item type for the same message. This is model judgement, not a taxonomy
gap, so the taxonomy data (and its seed migration) is unchanged.

- **The rule.** TAXONOMY.md classification rule 8, and the same sentence in
  all four prompts (`ITEM_TYPE_GOODS`): an item type that names goods is for
  the goods themselves, so a line paying for a machine cycle instead of
  goods keeps its subcategory and has no item type. It names machine
  cycles, not services: "never for a service" could lead a light model to
  drop Meals & Prepared Food from restaurant lines (rules 3-4). Membership,
  Cleaning Product and dryer sheets (Laundry Supply) are unaffected.
- **The guard.** Golden `laundromat-cycles` ("5 - washing machine, 3 -
  dryer") with a new `classes` expectation (each line's category /
  subcategory / item type as the card prints it), a unit test for the
  prompt sentence, and a journey that the saved lines carry no item type.
  `receipt-with-tip` (a clear sit-down receipt) pins its restaurant lines to
  Meals & Prepared Food with `classes`, so an over-broad reading of the rule
  fails the eval. `paid-by-family` gets no `classes`: "dinner at Salad Bar"
  may fairly be Takeout / Quick Service, and a flaky pin in a required check
  blocks PRs. It takes the 20th golden slot, which the 2026-11-08
  discount entry had pencilled in for a `receipt-order-discount` case; that
  case now needs a slot freed first.
- **Not yet proven for every model.** The issue's wrong answer came from
  Flash-Lite. The one live recording was answered by gemini-3.6-flash, so
  "whichever model answers" holds only once the nightly rotation has sent
  `laundromat-cycles` to Flash-Lite and it passed.
- **Hashes.** The prompt change makes every golden's `request_sha256`
  stale. CI does not commit them: the PR's eval run uploads refreshed
  goldens as its `goldens` artifact, and someone commits that by hand.

**Ruled out:** a post-extraction code guard that clears `Laundry Supply`
when a line's text names a machine cycle. The taxonomy has no column that
marks an item type as goods-only, so the guard would need a migration plus a
keyword list; "dryer" also names a supply ("dryer sheets"), so the keyword
match would clear correct answers. The rule fixes the cause in the place
the model reads.

## 2026-11-08 — A header that holds another funder's lines drops them, in code (#96)

A message listing purchases paid by another person and purchases the owner
paid gave two cards, one per funder, but the first header held the whole
message: 126.00 over lines of 120.00, the 6.00 being the owner's lines on
the second card. The line-sum check refused it, so nothing wrong was saved,
but the owner had to fix it by hand.

- **The split already exists.** `funded_by` is a field of the event, not
  of a line, in both the extraction and the Edit schemas. One event, and so
  one card or stored transaction, can never hold two funders, and no code
  partition by line is possible or needed. What can leak is a header total.
- **What code does** (`withoutLeakedTotals`, integer cents, after each
  event's discount, tax and tip are shared over its own lines and before
  validation). When an expense header exceeds its own line sum by exactly
  the line sums of all the other expenses in the same message with a
  different funder, its own line sum replaces it. Order and every other
  field are kept.
- **The card says so.** The replaced header is kept as `stated_amount`, and
  the card shows `! total 126.00 included 6.00 from the other funder's
  card; using 120.00`. Confirm stays. A card whose header already matched
  shows no such line. An Edit drops `stated_amount` with the rest of the
  model's answer, so the warning goes with it.
- **Tax, tip and discount** are parts of one event. Code shares them only
  over that event's lines, so they never cross a funder. A sibling counts by
  its lines as paid (tax and tip in), so a leak of its pre-tax price does
  not match.
- **Refuse otherwise.** Any other gap, a header below its lines, a gap
  that only some of the other funders' lines explain (a partial leak among
  three funders), or one that only a same-funder sibling explains keeps the
  header, and the card
  fails the line-sum check with nothing saved. Same-funder grouping is #97
  and is left to it.
- **Edit.** The patch returns one event with one `funded_by`, so an Edit
  that names who paid for one line changes the funder of the whole
  transaction. It cannot create a mixed one; it has no siblings, so the rule
  does not run there.

The risk that remains: a header that is right while a line is misread,
with a gap that happens to equal the differently funded siblings to the
cent (a 10.00 header over 6.00 of lines next to a 4.00 sibling), gets the
misread total and Confirm. No narrower rule tells that apart from #96, so
the warning line puts it in front of the owner instead of passing silently.

**Ruled out:** a subset search (the first version: any subset of the other
funders' lines). A model that leaks the whole message leaks every sibling,
so the subset only added matches, and each extra match is another chance
of the coincidence above; a partial leak now fails safe. A prompt rule
(stale goldens, about 20 live calls, and it would hold only for the model
that reads it); always recomputing a mixed
message's headers from the lines (drops the receipt total as a check on
every misread line); a `funded_by` per line (a schema change, and a line
never has a funder of its own).

## 2026-11-08 — Marts are live views

Phase 5 PR B. Grafana's This month and Ledger need a Confirm to show up
without waiting for the 08:45 UTC nightly rebuild. The ledger is tiny, so
query cost is not the constraint.

- **Every model in schema `marts` materializes as a view** (`dbt_project.yml`).
  Staging was already views. dbt still runs nightly and recreates them; the
  definitions stay the single source of truth, and Grafana reads through
  `finflow_analyst` at query time (including `toronto_today()` / current
  month logic).
- **CI lists marts via `information_schema.tables`**, not `pg_tables`, so
  views are included. `analyst_reads_every_mart` already scanned
  `relkind in ('r','v','m','p')`. Migration 0013's default privilege
  `GRANT SELECT ON TABLES` covers views in Postgres.
- **First production build after merge** drops the old mart tables and
  creates views of the same names; no migration. Dispatch `dbt-nightly`
  after merge and confirm it is green.

**Ruled out:** keeping nightly tables with a "data as of last night" note
on This month (defeats D1 mid-day); incremental marts (a backdated row
must restate its month on the next definition refresh; full recreate is
cheap).

## 2026-11-08 — Ledger listing mart is one row per transaction

Phase 5 PR A2. The Ledger dashboard lists whole entries as logged, with
line items nested from `fct_transactions`.

- **Grain is the header**, one row per `transactions` row. Line-level
  metrics stay on `fct_transactions`. Not a MetricFlow model.
- **Built from staging**, not by rolling up `fct_transactions`, so a
  line-grain MetricFlow change cannot reshape the listing.
- **`category_summary`'s `+n` counts extra distinct category › subcategory
  paths**, not extra lines: two grocery lines still show as Groceries
  with no `+n`.
- **`subcategory_paths` is distinct paths** ordered by the largest line
  in that path, so a Grafana `= any()` filter is not duplicated.
- **`counterparty`**: an expense omits a missing merchant or venue rather
  than rendering ` · venue`; a transfer always names both sides,
  substituting `Chequing` for a null account.
- **`needs_amount` and `wants_amount` are `0`** on income and transfers,
  not null, so a sum over the table is still numeric.

**Ruled out:** flattening the ledger to line grain (defeats "whole entries
as logged"); putting series name on `fct_transactions` (unchanged per the
spec).

## 2026-11-08 — Rolling windows are a long-format mart, not extra plan columns

Phase 5 PR A3. Trends T1 needs 3-month and 12-month share ratios of sums.

- **Generalize "Rolling 3 months" to "Rolling N months"** in the contract.
  `fct_month_plan.*_pct_3m` stays N = 3, so This month and Review keep
  working. New N do not add columns there.
- **`fct_month_rolling`**, long format, one row per (month, N) for N in
  the dbt var `window_months` (default 3, 12). Sums and ratios are null
  unless every month of the window is complete and in the list, so a
  12-month line does not start until a year of complete months exists.
- **Not a MetricFlow model**, same reason as the other planning marts.

**Ruled out:** `*_pct_12m` columns on `fct_month_plan` (wide format grows
with every N); showing partial windows (a 5-month mean labelled 12 would
lie).

## 2026-11-08 — Opening balances for savings accounts only

Phase 5 PR A4. Trends T4/T5 need a real savings pot, not just flows.

- **Schema only in the migration.** `account_opening_balances` is one row
  per account (`as_of`, `amount numeric(12,2)`). The owner enters values
  with a placeholder SQL snippet in the Supabase editor. Nothing in a
  tracked file holds a real name, date or amount.
- **`fct_account_month`**, one row per (month of the month list, account),
  zero-filled. Deposits are chequing into the account (they sum to
  `transfers`); withdrawals the reverse (they sum to `withdrawals`);
  moves between named accounts net to 0. `balance` is opening plus
  flows with `occurred_on > as_of` through month end.
- **Investment never gets a computed balance**, even if an opening row
  exists: market values are not logged, so the line is
  contributed-since-tracking (`net_flow_cumulative`). Debt already has
  no balance (DATA_MODEL).
- **Not a MetricFlow model**, same reason as the other dashboard marts.

**Ruled out:** putting owner amounts in the gitignored seed overlay or
any tracked file (the repo is public); treating an investment opening as
a market value; reconstructing months that end before `as_of`.

## 2026-11-08 — Grafana data source settings, checked against the plugin

Phase 5 PR C. `infra/grafana.tf` follows the spec template; the "verify at
build" items were checked against the pinned provider (4.45.1 in the lock
file, `terraform providers schema`) and the Postgres plugin's source
(`grafana/grafana-postgresql-datasource`).

- **Type `grafana-postgresql-datasource`.** The plugin id; `postgres` is
  only an alias.
- **TLS keys.** `jsonData.sslmode = "verify-full"` and
  `jsonData.tlsConfigurationMethod = "file-content"`, CA in
  `secureJsonData.tlsCACert`. The plugin writes that content to a temp file
  and passes it to pgx as the root cert, so pgx checks the CA and the host
  name. No `tlsAuth` / `tlsAuthWithCACert` flag: those belong to HTTP and
  MySQL data sources and the Postgres plugin does not read them. Whether
  Grafana Cloud's handshake passes is still decided by "Save & test";
  fallback `verify-ca`.
- **Database in `jsonData.database`**, not the provider's `database_name`
  (the plugin reads `jsonData` first).
- **User `finflow_analyst.<project ref>`**, the pooler's `<role>.<ref>`
  form the nightly dbt uses, built from `supabase_project.finflow.id` so
  no ref is tracked.
- **Connection limits.** `maxOpenConns` 3 and `connMaxLifetime` 300 are
  applied (pgxpool `MaxConns`, `MaxConnLifetime`). The plugin now runs on
  pgxpool, which ignores `maxIdleConns`; it is kept at 1 for older plugin
  versions and costs nothing.
- **No password in Terraform at all.** The spec template sent a
  placeholder password under `ignore_changes`. Review found the provider
  sends secure data on every update, so with that block any later in-place
  change (URL, name, `json_data`) would overwrite the password typed in the
  UI with the placeholder, and panels would fail on auth. Grafana keeps a
  secure key an update leaves out, so `secure_json_data_encoded` carries only
  the public `tlsCACert` and there is no `lifecycle` block. A recreated data
  source has no password until the owner re-enters it (fails closed).
- **Provider block in `grafana.tf`**, like `provider "supabase" {}` in
  `supabase.tf`, reading `GRAFANA_URL` / `GRAFANA_AUTH` from the
  environment. Provider pin `~> 4.44` unchanged.

**Ruled out:** a Terraform variable for the password or token (state and
plan would hold them); a placeholder password under `ignore_changes` (the
update overwrites the real one); `tlsSkipVerify`; the `file-path` TLS method (Grafana
Cloud has no file system to point at).

## 2026-11-08 — Fold the deposit into `transfer-withdrawal`; retire `transfer`

Owner decision. Supersedes the "Keep `transfer`" entry above; retiring
`transfer`, ruled out there, is now done. The 20-case cap stays, and
`laundromat-cycles` keeps its slot.

- **The deposit check moved, it did not vanish.** `transfer` was the only
  case where Gemini read a deposit (`from_account` null, `to_account`
  set). `transfer-withdrawal` now sends a deposit, a withdrawal and a move
  between two accounts in one message and expects all three directions,
  the deposit first. A deposit read as coming from an account still fails
  the eval live. Each event pins its amount and accounts, not the date or
  the description, so the case stays robust.
- **`transfer` goes.** The journeys that replayed it use the deposit
  event of `transfer-withdrawal`; the TESTING.md rows that cited it cite
  the extended case.
- **`receipt-order-discount` takes the freed slot** (20 of 20). A
  synthetic housewares receipt prints a member discount on the whole order
  (`-3.00`) before GST and QST; the case pins each line's amount, so it
  fails when Gemini reads the discount as a line, puts it on one line, or
  ignores it. It cannot tell a whole-order discount from the same 10% taken
  off each price, which gives the same amounts. This closes the "No
  golden yet" gap in the whole-order discount entry above.

**Ruled out:** raising the cap (same reason as before); dropping the
deposit check with `transfer` (a deposit is the most common transfer).

## 2026-11-08 — Reset the `finflow_analyst` password for Grafana; no other role

Phase 5 PR C. The first "Save & test" failed on the password (TLS and the
pooler user were fine): `finflow_analyst` had its password set once in
2026-10 and never stored, and `.env` holds the `finflow_readonly` password,
a different role. The owner set a new `finflow_analyst` password with `alter
role` and entered it in the Grafana UI; nothing in production used the old
one (Grafana is the only consumer; CI uses a throwaway on the test database).

**Ruled out:** connecting Grafana as `finflow_readonly` (it reads raw
tables) or as `finflow_dbt` (it writes `staging` and `marts`); either would
drop the marts-only boundary the dashboards rely on.

## 2026-11-08 — `finflow_analyst` defaults to `jit = off`

Phase 5. Querying the stacked mart views as `finflow_analyst` through the
session pooler took 7-10 s in a local test with PostgreSQL JIT on and about
0.1 s with `jit = off`. The dashboard CI check passed `-c jit=off` by hand;
Grafana's Postgres data source has no per-connection setting, so migration
0023 sets it as a role default (`alter role finflow_analyst set jit = off`).
`dbt:analyst_jit_off` guards it. The dashboard PR drops the harness flag so
CI tests what production runs.

**Ruled out:** a database-wide default (the dbt builds and the Lambda have
not been measured); the same default on `finflow_dbt` (left unchanged: it
runs heavy builds and nothing says JIT hurts it).

## 2026-11-08 — This month dashboard: choices the panel list left open

Phase 5 PR D (`grafana/dashboards/this-month.json`). The panel list, the
colours and the queries' shape were settled before the build; these are
the details it left open.

- **The status line is one text value** built in SQL ("Day 15 of 31 ·
  income received 41% of expected · baseline 3 months"), not four stat
  fields. It reads as one sentence, and the edge wording lives in the
  query: "Complete month", "Not started" (a future month), "no expected
  income yet", "baseline: 2 months (thin)", "no baseline yet".
- **Wants left is two rows (label, amount) in one stat.** Grafana titles
  each value from the row's text column, so a complete month reads "Wants
  left at month end" and drops the per-day row (no days remain). The
  per-day value spreads what is left over the days left, today included,
  rounded to cents. A negative amount is red with its minus sign; there is
  no "over by" prefix, because a Grafana value mapping replaces the value
  instead of prefixing it.
- **"Usual by today" reads `fct_pace_day` at the mart's `as_of_day`**, not
  at `least(Toronto today, month end)` in the panel. In production it is
  the same day; on the fixture it follows the pinned today, so CI runs
  what production runs. A future month (`as_of_day` 0) has no pace row and
  reads "no pace yet".
- **Financial future in the bucket table:** Left is `greatest(plan − used,
  0)`; Status is "due by month end", or "Done ✓" once used reaches the
  plan. It is never warning-coloured.
- **Used % gauge cells are neutral gray, not the bucket colour.** A Grafana
  table colours a cell only from its own value, so a per-row bucket colour
  cannot reach the gauge; the Bucket column names the row. The Status
  column has a coloured background (warning for "▲ ahead of usual pace",
  good for on pace, behind and done), always with the glyph and words.
- **Ledger links wait for PR E.** The Bucket and category data links and the
  "Entries this month →" header link need the Ledger's uid and variables,
  which E defines; D ships the tag-based link to the other `finflow`
  dashboards only.
- **Grafana's home is set in Terraform**:
  `grafana_organization_preferences.home_dashboard_uid`, with `timezone =
  "America/Toronto"` set explicitly. The provider writes every preference
  at once, so each apply resets the unset ones (theme, week start) to
  Grafana's defaults; the CoS reads the live preferences before the first
  apply.
- **CI**: `grafana/scripts/check_dashboards.py` runs every query for each
  `month` the fixture has (8), as `finflow_analyst`, with the role's own
  settings: its `jit = off` default (migration 0023, the entry above)
  applies on the fixture as on production, so CI runs the queries the way
  Grafana does and passes no flag of its own. A separate `Terraform` workflow
  (fmt -check, `init -backend=false`, validate; no credentials) is not
  required. It is not a job in CI because the Lambda deploy runs only when
  the whole CI run succeeds, so a red non-required job there would hold
  back deploys.

**Ruled out:** a Trend panel (numeric x) for the pace charts, which would
follow the `month` variable without the time picker, since the design names
time series; `dashboard-linter` (a new dependency for checks the script
already makes).

## 2026-11-09 — Declare `pdcInjected` on the Grafana data source

The first plan after the data source was created showed an in-place update:
Grafana Cloud adds `pdcInjected = true` to every data source's `jsonData`, and
Terraform wanted to remove it. An update resends secure data, so a spurious
one risks the password the owner typed in the UI. `grafana.tf` now declares
the field, so the plan shows no change on the data source.

**Ruled out:** `ignore_changes` on `json_data_encoded` (it would hide real
changes to the connection settings); a targeted apply that skips the data
source (a workaround that leaves the drift).

## 2026-11-10 — This month, round 1 of owner feedback: shares of income, plain labels

The owner opened This month (applied 2026-11-09) and described what to
change. Their description overrides the Rev 10/11 panel list and the
2026-11-08 "choices the panel list left open" entry where they disagree.

- **The bucket table answers 50/30/20, not pace.** "Buckets vs targets":
  So far, % of income, Target, Status (within / over target; financial
  future is met, due by month end, or below target once the month is
  complete). Plan, Left, Used % and "Usual by today %" are gone: the owner
  reads the buckets as shares of income, and pace belongs to the charts.
- **The denominator is a toggle** (`income_base`): expected income by
  default (shares mean something from day 1), or income received so far.
  A complete month uses its actual income either way, since
  `spendable_income_expected` is `spendable_income` there. The 2026-11-07
  ruling against shares of income so far stands as the default; the owner
  asked to see that view on demand.
- **"Usual" is spelled out** as "Mean of previous 3 full months". The
  status line names how many months the mean has when it is fewer.
- **Pace is the line's colour.** Each pace chart splits this month's line
  in SQL into the part at or below the mean and the part above it (red).
  A Grafana line cannot take its colour from another series, so it is two
  series; a crossing segment belongs to the side it ends on.
- **"Plan at your usual timing" is replaced** by a flat "Wants target for
  the month". Nobody could read the sloped line.
- **Categories compare like for like.** New
  `fct_subcategory_month.spend_to_date_avg_3m`: the baseline months' spend
  through the matching day. The whole-month mean stays as a third, fainter
  bar. A category is listed only with spend this month or in at least 2 of
  the previous 3 full months, so a one-off fee or trip never reads as
  usual. That rule is in the panel query (it needs a count of months per
  category, and the mart's grain is the subcategory).
- **"Buckets by month" added**: complete months, stacked shares of income
  with unallocated as the fourth part, and income as a line on the right
  axis. Trends (G) may take it over.
- **"Needs left" added** beside "Wants left", as a big number: the needs
  target minus needs spent so far. No per-day figure, since fixed bills
  land on set dates.
- **Panel help is one or two sentences**, definitions only.

**Ruled out:** income received so far as the default denominator (over
target every month until pay arrives); a per-row gauge against each
target (a table cell is coloured from its own value only, and the targets
live in `budget_targets`, not in the JSON); a same-day mean as the only
category reference (the whole-month mean is the steadier one for a
category bought a few times a month).

**Not verified:** how the changed panels render. Watch the two-series
pace line at a crossing, the stacked bars with a negative unallocated
share, the right-axis income line, and the 12-month panel time override.

## 2026-11-10 — Owner answers for the dashboards still to build

Asked after round 1 of This month so E, F and G start closer to what the
owner wants. These override the Rev 10/11 spec where they differ.

- **Ledger (E) lists line items**, not whole purchases: one receipt can
  span categories and buckets. Filters: month, bucket, category, merchant,
  tag and free-text search, all of them. It also wires This month's
  category and bucket links.
- **Review (F) shows three things:** whether needs and wants stayed within
  their targets and financial future reached its own; the biggest changes,
  meaning each category's spend minus the mean of the previous 3 full
  months, sorted by size; and entries to fix.
- **Entries to fix are wanted at once, not at month end.** Proposed and not
  yet built: a "Needs attention" panel at the top of This month, empty
  when clean, fed by the existing mechanical checks (likely duplicates,
  date sanity, cards never confirmed, cards read by the lighter model,
  recurring payments due and not logged). It needs a mart first, since
  `finflow_analyst` reads only `marts`.
- **Trends (G) is "Buckets by month"** and its windows. No savings balance
  and no net worth: the owner reads those in their bank's app. T4/T5 and
  the dashboard use of `fct_account_month` are dropped unless asked for.
- **Comparison windows are 3 and 6 months, and 12 when there is history.**
  No same-month-last-year: spending and income are not seasonal.
  `window_months` is 3 and 12 today, so 6 is to be added.
- **Unallocated is expected to be zero at month end** (the owner allocates
  everything), so a visible unallocated share in a complete month points
  at a transfer that was not logged.
- **Merging:** the owner allows a merge without asking once every check is
  green (2026-11-10), which relaxes the per-PR "merge" of 2026-11-09. A
  red check is still fixed, never merged past. `terraform apply` stays
  with the owner's main checkout, where the state file lives.

**Ruled out:** whole-purchase rows in the Ledger; a balance or net-worth
panel; a same-month-last-year reference.

## 2026-11-10: This month, round 2 of owner feedback

The owner saw round 1 applied, liked "Buckets vs targets" and the day
charts, and reported three problems: no income in money, "Buckets by
month" does not belong on a page about one month and broke when the time
range changed, and it was unclear whether the month dropdown or the time
picker sets the period.

- **The month dropdown is the only period control.** The time picker is
  hidden on every dashboard and no panel reads the time range. Before
  this the day charts were time series on real dates, so an earlier month
  in the dropdown left them empty until the time picker was moved too.
- **Day charts are Trend panels** with the day of the month (1 to 31) on
  x. This reverses the 2026-11-09 ruling that kept time series because
  the design named them; the owner's description overrides that design.
- **"Income" panel on This month:** income received, and expected for the
  month while it is open (a complete month shows only what was received).
- **Trends dashboard started early** to hold "Buckets by month": a bar
  chart with months as categories, the last 12 complete months, so its
  shape cannot depend on a time range. Income by month is a second bar
  chart under it, because the bar chart panel cannot draw a line over the
  bars. The rest of Trends (G: 3, 6 and 12 month windows) is still to do.

**Ruled out:** keeping a time series with a fixed panel time override
(dragging on any chart still moves the range); a time picker synced to
the dropdown (Grafana has no such link without a plugin).
