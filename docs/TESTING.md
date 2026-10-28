# Testing

Every owner-visible behaviour of the bot has an automated test, and a PR that
breaks one cannot merge. No test touches production. Design and the choices
it ruled out: DECISIONS.md 2026-10-28.

## Behaviour inventory

One row per behaviour. The Tests column cites each guarding test by its exact
title in backticks, one per line. `golden:<name>` cites a case file in
`lambda/tests/golden/`, which both the journeys replay and the live eval
checks. `scripts/check-inventory.mjs` (CI job `inventory`) fails when a row
cites no test or cites one that does not exist.

A title that comes from `it.each` is cited as written in the source, `%s`
included.

| Area | Behaviour | Tests |
|---|---|---|
| Security | A request with a bad webhook secret is refused with 401 and nothing happens | `rejects a bad webhook secret`<br>`a request without the webhook secret is refused and nothing happens` |
| Security | A chat or button tap that is not on the allowlist is ignored: no reply, no pop-up, nothing saved, Gemini not called | `a message from another chat is ignored: no reply, nothing saved, Gemini not called`<br>`a button tapped from another chat does nothing` |
| Text | A valid text purchase is saved as pending and shown as a card with Confirm, Discard, Fix date and Edit | `previews a valid extraction with Confirm buttons and persists pending`<br>`a text purchase shows a card, and Confirm saves it with its date and reason`<br>`puts Confirm and Discard on the first row and Fix date and Edit on the second`<br>`saves every event of one update as pending, in order` |
| Text | A card whose checks fail has no Confirm and is not persisted | `does not persist or offer Confirm when checks fail`<br>`omits Confirm but keeps Edit when confirm is false`<br>`rejects when line cents do not sum to the header`<br>`rejects unknown venue or tag` |
| Dates | No date: today is used and the card warns, and Confirm stays | `defaults a missing Gemini date to today and warns`<br>`defaults text with no date to today and warns`<br>`a purchase with no date uses today, warns, and can still be confirmed`<br>`golden:no-date-text` |
| Dates | Fix date asks for the date, and the reply applies it | `asks for a date on Fix date and does not confirm`<br>`applies a date reply while awaiting and does not start a new extraction`<br>`Fix date asks for the date, and the reply brings the card back with Confirm`<br>`routes a date reply to the waiting row and then stops waiting`<br>`accepts ISO, today, yesterday, and month-day names` |
| Dates | While a date is awaited, a new expense or a non-date is not taken as the date | `does not treat a new expense as a date while awaiting_date`<br>`a reply that is not a date asks again and changes nothing`<br>`rejects a new expense or an impossible calendar day` |
| Photo | A receipt photo is archived to S3 as `{id}.jpg` and offered for Confirm | `extracts a receipt photo, archives it, and offers Confirm`<br>`a receipt photo is archived and offered for Confirm`<br>`puts the JPEG at {ingestionId}.jpg and returns that key`<br>`picks the photo size with the greatest file_size`<br>`gets file_path then downloads bytes from the file URL`<br>`sends JPEG inline data plus caption once, with the rules in the system instruction` |
| Photo | A receipt with no date is persisted without Confirm until a date is given | `persists a dateless photo without Confirm`<br>`a receipt with no printed date is saved without Confirm until a date is given`<br>`does not default a photo with no date`<br>`golden:receipt-no-date` |
| Voice | A voice note is archived as `{id}.ogg` and offered for Confirm | `extracts a voice note, archives it, and offers Confirm`<br>`a voice note is archived as audio and offered for Confirm with today's date`<br>`puts Ogg audio at {ingestionId}.ogg when contentType is audio/ogg`<br>`sends Ogg inline data plus caption once, with the rules in the system instruction`<br>`golden:voice-note` |
| Voice | A voice note with no date defaults to today with a warning; one that fails checks is not persisted | `defaults a missing voice date to today and still offers Confirm`<br>`does not persist a voice note when checks fail` |
| Edit | Edit asks for a correction, and the correction replaces the stored extraction in one request | `asks for a correction on Edit and does not confirm`<br>`Edit asks for the correction, and the corrected card saves the new amount`<br>`applies a correction while awaiting_edit and does not start a new extraction`<br>`applies a correction only while the row awaits an edit`<br>`sends the current extraction, its buckets, and the correction in one call with no media`<br>`golden:edit-amount` |
| Edit | A correction can change a line's bucket, and only that line's | `an Edit that says a line is a need changes its bucket in one request`<br>`an Edit that calls one receipt line a need saves that change and keeps the other lines`<br>`returns the bucket the correction changes`<br>`golden:rules-edit-need` |
| Buckets | The needs/wants rules set each line's bucket and overrule a subcategory's hint; where no rule speaks, the hint applies | `golden:rules-override`<br>`golden:rules-mixed-receipt`<br>`golden:rules-default-hint`<br>`reports each line whose bucket differs from the expected one` |
| Edit | A correction that fails checks is rejected and the card keeps waiting | `does not apply a correction that fails checks`<br>`a correction that breaks the card is shown without buttons and the card keeps waiting` |
| Edit | A new photo or voice note is not started while a card waits for a correction or a date | `does not start a new photo while awaiting_edit`<br>`a voice note sent while waiting for a correction is not read`<br>`does not start a new photo while awaiting a date`<br>`does not start a new voice note while awaiting a date`<br>`a photo sent while a card waits is not read, and the bot asks for the date` |
| Confirm | Confirm writes the transaction, its lines with their buckets, tags, venue, merchant, funder and note | `writes an expense with its lines, tags, venue, merchant, funder and note`<br>`two items at one store stay one card with two lines`<br>`a merchant from the lookup is linked, and one outside it is left unattached`<br>`saves a merchant that is not in the lookup as no merchant` |
| Confirm | A second tap on Confirm says "Already handled." and writes nothing more | `reports already handled on a second tap and writes one transaction`<br>`tapping Confirm twice saves once and says it was already handled`<br>`will not confirm a discarded row`<br>`rejects a row that fails checks and writes nothing` |
| Confirm | Money is two-decimal text, stored as `numeric(12,2)`, and every database constraint holds | `parses two-decimal money as integer cents`<br>`rejects floats that are not two-decimal strings`<br>`store money as numeric(12,2)`<br>`reject %s` |
| Discard | Discard drops the card without a transaction, and a second tap says "Already handled." | `Discard drops the purchase, and a second tap says it was already handled`<br>`discards a pending row once`<br>`leaves a confirmed row alone` |
| Income and transfer | Income needs a source and has no lines or funder; a transfer goes to an account | `requires income_source and no lines on income`<br>`writes income with its source and no funder or lines`<br>`writes a transfer to its account`<br>`moving money to savings is saved as a transfer to that account`<br>`golden:transfer` |
| Funding | An expense has a funder (self unless someone else paid); income and transfer have none | `defaults expense funded_by to self when Gemini returns null`<br>`someone else paying is saved with them as the funder`<br>`records who paid when someone else funded it`<br>`keeps the name on expenses and drops it otherwise`<br>`omits Funded by on income even when extraction still has a leftover value`<br>`omits Funded by on transfer`<br>`golden:paid-by-family` |
| Notes | A note in the owner's words, with spelling, typos, punctuation and grammar fixed and nothing added, is shown on the card and written to `transactions.notes` | `writes the note to transactions.notes`<br>`shows the note under the description, and no Note line without one`<br>`asks Gemini for a nullable note in the owner's words`<br>`asks Gemini to copy-edit the note lightly and add nothing`<br>`golden:text-with-note` |
| Multi-event | Purchases at different places split into one card each, labelled "(i of n)" | `two stores become two labelled cards, each saved on its own Confirm`<br>`inserts two events in one batch and sends two labelled cards in order`<br>`labels the header (i of n) only when a message has several events`<br>`golden:two-stores` |
| Multi-event | Items at the same place, or with no place, stay one card with several lines | `two items at one store stay one card with two lines`<br>`two items with no place stay one card with two lines`<br>`golden:same-place-lines`<br>`golden:no-place-lines` |
| Multi-event | Income and a purchase in one message become separate cards | `a purchase and a paycheque become an expense card and an income card`<br>`golden:expense-and-income` |
| Multi-event | A receipt with a caption purchase gives two cards sharing one S3 object | `a receipt with a caption purchase becomes two cards sharing one archived photo`<br>`uploads a photo once, keyed by the first persisted event, shared by both rows`<br>`golden:receipt-with-caption` |
| Multi-event | An invalid event is previewed without buttons; when all are invalid nothing is saved | `an event that fails checks is shown without buttons and is not saved`<br>`persists the valid event, previews the invalid one without buttons, and moves usage`<br>`uploads nothing and inserts nothing when every event fails checks` |
| Multi-event | A webhook retry saves no second set and sends no cards, even when two arrive at once | `Telegram resending the same message saves nothing new and sends no new cards`<br>`sends no cards when the batch is a webhook retry`<br>`rejects a retry that produced different event indexes`<br>`lets exactly one of two concurrent inserts of one update win`<br>`rolls back and reports a duplicate when a retry hits the unique key` |
| Waiting | Only one card waits at a time: Fix date or Edit on another card says "Finish the waiting card first." | `Fix date on card 2 while card 1 waits says to finish the waiting card first`<br>`Edit on card 2 while card 1 waits says the same`<br>`%s while another card is waiting replies busy and sends no keyboard`<br>`lets only one card wait at a time`<br>`%s returns busy and skips the UPDATE when another row is waiting` |
| Waiting | Confirm on another card works while one waits, and discarding the waiting card frees the wait | `Confirm on card 2 while card 1 waits for a date saves card 2 normally`<br>`discarding the waiting card lets another card wait`<br>`frees the wait when the waiting card is discarded` |
| Failures | Gemini overload (503) gets the overload reply and saves nothing | `Gemini overloaded on every model: the bot says so and saves nothing`<br>`tells the owner Gemini is overloaded when text extraction gets a 503`<br>`says the same for a receipt photo` |
| Failures | Any other extraction failure gets an input-specific reply | `keeps the input-specific message for other failures`<br>`Gemini finds no purchase: the bot asks to try again in a sentence`<br>`replies with the parse failure when Gemini returns no events`<br>`throws when Gemini returns no events` |
| Failures | A card that fails to send after saving is logged and the other cards still go out | `a card that fails to send after saving does not stop the next card or blame the message`<br>`keeps sending cards and does not report a parse failure when a card send fails after saving`<br>`still reports a failure when nothing was saved and the preview send fails` |
| Gemini | A 503 or 429 retries down the model chain; other errors do not retry | `retries a 503 on the fallback model and records which model answered`<br>`retries a non-JSON 503 body too`<br>`gives up after three attempts with the HTTP status in the error`<br>`moves to the next model on a 429, since free-tier quota is per model`<br>`does not retry a bad request` |
| Gemini | A card read by the Lite model warns to check categories and buckets, and only then | `only the lighter model answered: the card says to check categories and buckets`<br>`flags a card that a Lite model read, and only then` |
| Gemini | A message is one request with the buckets included, and the rules never reach the logs | `makes one call that returns buckets, with the rules after the taxonomy`<br>`reads needs from the item and maps anything else to wants`<br>`never logs the system prompt, so the rules stay out of CloudWatch`<br>`sends the API key in a header, not the URL` |
| Gemini | Token usage is stored on the first event of a message only | `persists the valid event, previews the invalid one without buttons, and moves usage` |
| Taxonomy | The taxonomy comes from the database and rejects a subcategory or item type that is not in it | `returns the generic seed plus the example overlay, nothing personal`<br>`rejects an item_type from a different category than the subcategory`<br>`accepts a balanced expense with live taxonomy` |
| Safety | Tests refuse any database that is not on this machine, and the read-only role writes nothing | `refuses a database that is not on this machine`<br>`can read every public table and write none of them`<br>`is refused a write when it tries one` |

## Running each layer

Run from `lambda/`.

| Layer | Command | Needs |
|---|---|---|
| Unit | `npm run test:unit` | nothing |
| Integration and journeys | `npm run test:integration` | `TEST_DATABASE_URL` |
| Everything | `npm test` | `TEST_DATABASE_URL`, or the database layers are skipped with a warning |
| Coverage floor | `npm run test:coverage` | `TEST_DATABASE_URL` |
| Eval (live Gemini) | `npm run eval` | `TEST_DATABASE_URL`, `GEMINI_EVAL_API_KEY` |
| Inventory | `node scripts/check-inventory.mjs` (repo root) | nothing |

A throwaway Postgres for the database layers: start Docker, run
`npm run db:up`, then
`export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres`.
The harness recreates a `finflow_test` database on it and refuses any other
host. `npm run db:down` stops it.

CI (`.github/workflows/ci.yml`) reports four jobs on every PR: `unit`,
`integration`, `eval` and `inventory`. `inventory` runs the inventory check
and the coverage floor (lines 90, statements 90, branches 84, functions 98;
raise it, never lower it). The deploy workflow runs only after CI succeeds
on `main`.

## The eval and its key

`npm run eval` sends every golden case to live Gemini through the production
extraction code and checks the answer against the case's `expect`. It passes
without calling Gemini when no path that changes the request or the judging
moved since the base commit. Add `-- --record` to refresh a golden's
`recorded` from a live answer that satisfies `expect`.

Key setup, once:

1. In Google AI Studio create a project **separate from the production
   bot's**, and an API key in it. Free-tier quota is counted per project (20
   requests a day on each Flash model), so a key from the production project
   would spend the bot's daily requests.
2. Add the key as the `GEMINI_EVAL_API_KEY` Actions secret. Export it to run
   the eval locally.

A case answered by a fallback model passes when its answer satisfies
`expect`: a real message sent that day would have been answered by the same
model (owner ruling 2026-10-28, DECISIONS.md). The job summary still lists
each case's answering model.

## Adding or changing a behaviour

In the same PR: add or change its row above, add a journey for it in
`lambda/tests/journeys/`, and add a golden case when Gemini's answer is part
of the behaviour. The `inventory` job fails the PR otherwise.
