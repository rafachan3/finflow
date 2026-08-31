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

