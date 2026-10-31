# Testing

Every owner-visible behaviour of the bot has an automated test, and a PR that
breaks one cannot merge. No test touches production. Design and the choices
it ruled out: DECISIONS.md 2026-10-28.

## Behaviour inventory

One row per behaviour. The Tests column cites each guarding test by its exact
title in backticks, one per line. `golden:<name>` cites a case file in
`lambda/tests/golden/`, which both the journeys replay and the live eval
checks. `dbt:<name>` cites a singular dbt test, `dbt/tests/<name>.sql`.
`ci:<name>` cites a step by its `name:` in `.github/workflows/`, for a check
that is a CI step rather than a test file.
`scripts/check-inventory.mjs` (CI job `inventory`) fails when a row
cites no test or cites one that does not exist.

A title that comes from `it.each` is cited as written in the source, `%s`
included.

| Area | Behaviour | Tests |
|---|---|---|
| Security | A request with a bad webhook secret is refused with 401 and nothing happens | `rejects a bad webhook secret`<br>`a request without the webhook secret is refused and nothing happens` |
| Security | A chat or button tap that is not on the allowlist is ignored: no reply, no pop-up, nothing saved, Gemini not called | `a message from another chat is ignored: no reply, nothing saved, Gemini not called`<br>`a button tapped from another chat does nothing`<br>`a recurring button tapped from another chat does nothing`<br>`a card's series toggle tapped from another chat does nothing`<br>`a delete tapped from another chat deletes nothing`<br>`an Apply tapped from another chat links and ignores nothing` |
| Security | `finflow_dbt` reads the ledger and writes only `staging` and `marts`: it can create, replace and drop relations there, and is refused every write and any CREATE in `public`, and cannot drop its schemas | `holds SELECT on every public table and no write privilege on any`<br>`selects from the ledger but is refused every write and any CREATE in public`<br>`creates, replaces and drops tables and views in %s`<br>`cannot drop or take over its schemas, or create a schema` |
| Security | `finflow_analyst` reads only `marts`, including a table dbt rebuilds, and nothing in `public` (no raw Telegram payloads) or `staging`; it cannot write or create anything | `reads a mart table dbt builds, including after dbt drops and rebuilds it`<br>`reads no ledger table: not transactions, not the raw Telegram payloads`<br>`cannot read staging, write a mart, or create anything` |
| Security | After every `dbt build`, `finflow_analyst` can still read every mart (schema `USAGE`, `SELECT` on each table); CI also logs in as it and reads them, and is refused `staging` and `public` | `dbt:analyst_reads_every_mart` |
| Security | Supabase's Data API roles (`anon`, `authenticated`) reach nothing: no grant on `public`, `staging` or `marts`, no privilege on any table, sequence or routine in them, and no default privilege that grants them a table a later migration adds, while `finflow_readonly` and `finflow_dbt` still read it; the nightly checks production | `lose every grant Supabase gives them, and later tables are not granted to them`<br>`migration 0015 is a no-op where the roles do not exist`<br>`dbt:data_api_roles_reach_nothing`<br>`ci:a grant to anon fails data_api_roles_reach_nothing, and nothing else` |
| Text | A valid text purchase is saved as pending and shown as a card with Confirm, Discard, Fix date and Edit | `previews a valid extraction with Confirm buttons and persists pending`<br>`a text purchase shows a card, and Confirm saves it with its date and reason`<br>`puts Confirm and Discard on the first row and Fix date and Edit on the second`<br>`saves every event of one update as pending, in order` |
| Text | A card whose checks fail has no Confirm and is not persisted | `does not persist or offer Confirm when checks fail`<br>`omits Confirm but keeps Edit when confirm is false`<br>`rejects when line cents do not sum to the header`<br>`rejects unknown venue or tag` |
| Dates | No date: today is used and the card warns, and Confirm stays | `defaults a missing Gemini date to today and warns`<br>`defaults text with no date to today and warns`<br>`a purchase with no date uses today, warns, and can still be confirmed`<br>`golden:no-date-text` |
| Dates | Fix date asks for the date, and the reply applies it | `asks for a date on Fix date and does not confirm`<br>`applies a date reply while awaiting and does not start a new extraction`<br>`Fix date asks for the date, and the reply brings the card back with Confirm`<br>`routes a date reply to the waiting row and then stops waiting`<br>`accepts ISO, today, yesterday, and month-day names` |
| Dates | While a date is awaited, a new expense or a non-date is not taken as the date | `does not treat a new expense as a date while awaiting_date`<br>`a reply that is not a date asks again and changes nothing`<br>`rejects a new expense or an impossible calendar day` |
| Photo | A receipt photo is archived to S3 as `photo/{yyyy-mm}/{id}.jpg` and offered for Confirm | `extracts a receipt photo, archives it, and offers Confirm`<br>`a receipt photo is archived and offered for Confirm`<br>`puts the JPEG at photo/{yyyy-mm}/{ingestionId}.jpg and returns that key`<br>`picks the photo size with the greatest file_size`<br>`gets file_path then downloads bytes from the file URL`<br>`sends JPEG inline data plus caption once, with the rules in the system instruction` |
| Media keys | Media is archived at `{source}/{yyyy-mm}/{id}.{ext}` with the Toronto month, and `media_path` stores that key | `prefixes the source and the Toronto month`<br>`uses Toronto's month across the UTC month boundary`<br>`puts Ogg audio at voice/{yyyy-mm}/{ingestionId}.ogg when contentType is audio/ogg`<br>`a voice note is archived as audio and offered for Confirm with today's date` |
| Photo | A receipt with no date is persisted without Confirm until a date is given | `persists a dateless photo without Confirm`<br>`a receipt with no printed date is saved without Confirm until a date is given`<br>`does not default a photo with no date`<br>`golden:receipt-no-date` |
| Photo | A tip on a receipt or in a message is folded into the item lines with the tax, in proportion to each line's price: no tax or tip line, and the lines sum to the amount paid. An Edit that changes the tip replaces the old tip in the amount, not adds to it, and keeps that rule | `tells text, photo, voice and Edit to fold tax and a tip into the lines, with no tip line`<br>`golden:receipt-with-tip`<br>`golden:edit-tip` |
| Voice | A voice note is archived as `voice/{yyyy-mm}/{id}.ogg` and offered for Confirm | `extracts a voice note, archives it, and offers Confirm`<br>`a voice note is archived as audio and offered for Confirm with today's date`<br>`puts Ogg audio at voice/{yyyy-mm}/{ingestionId}.ogg when contentType is audio/ogg`<br>`sends Ogg inline data plus caption once, with the rules in the system instruction`<br>`golden:voice-note` |
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
| Duplicates | A saved card warns, in one `!` line under Checks, about a likely earlier copy: the same photo, or the same type and amount within 3 days (income also the same source, a transfer the same two accounts, so taking out what was just moved in is not a duplicate) among saved transactions and open cards. Covers expense, income and transfer. A photo match wins, else the nearest match, saved ahead of pending, with a `(+n more)` count. Events of one message never warn each other, discarded cards never match, and Confirm stays. The warning is recomputed on every render, Fix date and Edit included | `re-sending a confirmed receipt photo warns and keeps Confirm`<br>`a second paycheck of the same amount within 3 days warns, and the next one 14 days later does not`<br>`a transfer logged twice warns`<br>`taking out what was just moved to savings does not warn`<br>`a purchase still pending warns the next identical one`<br>`events of one message do not warn each other`<br>`a Fix date that moves a card next to a saved purchase warns on the new card`<br>`adds a likely duplicate to a saved card's checks and keeps Confirm`<br>`matches the same type and amount 3 days apart, but not 4`<br>`an income from another source does not match, the same source does`<br>`a transfer matches`<br>`a transfer between other accounts does not match, saved or pending; the same accounts do`<br>`finds confirmed and pending matches, nearest first and saved ahead of pending on a tie`<br>`events of the same message never match each other, saved or not`<br>`a discarded card is not a match`<br>`a dateless card uses the day it was sent in Toronto, on either side`<br>`a photo whose largest size was sent before matches by photo, ahead of amount matches`<br>`names the nearest amount match, saved or still pending, and counts the rest`<br>`shows only the photo match when there is one`<br>`is empty when nothing matches` |
| Duplicates | If the duplicate check fails, the saved card is still sent, without the warning | `sends a saved card without the warning when the duplicate check fails` |
| Income and transfer | Income needs a source and has no lines or funder; a transfer to savings is saved to that account | `requires income_source and no lines on income`<br>`writes income with its source and no funder or lines`<br>`writes a transfer to its account`<br>`moving money to savings is saved as a transfer to that account`<br>`golden:transfer` |
| Transfers | A transfer names the account it leaves, the one it enters, or both; the side left out is chequing. "Took 200 out of <account>" is a withdrawal whose card reads `From account: X` then `To account: chequing`; a move between two accounts names both; a deposit's card is unchanged (no `From account` line). Confirm writes `from_account_id`, and an Edit can change either side | `accepts a transfer that is %s`<br>`shows the account a transfer leaves: %s`<br>`omits Funded by on transfer`<br>`writes a withdrawal and a move between accounts with the account each leaves`<br>`taking money out of savings and moving it between accounts are saved with the account each leaves`<br>`an Edit that turns a deposit into a withdrawal saves the account it leaves`<br>`reports a transfer's accounts, reading a recording without from_account as chequing`<br>`golden:transfer-withdrawal`<br>`golden:transfer` |
| Transfers | A transfer with no account, an account not in the list, or the same account on both sides gets a card without Confirm and saves nothing; the database refuses the same, and a from account on income or an expense | `rejects a transfer with %s`<br>`a transfer that %s gets a card without Confirm and saves nothing`<br>`accept a deposit, a withdrawal and a move between two accounts as transfers`<br>`reject %s` |
| Gemini | Text, photo, voice and Edit prompts ask for the account a transfer leaves beside the one it enters, null meaning chequing, and an Edit sends the current one back; a from account Gemini puts on income or an expense is dropped | `asks text, photo, voice and Edit for the account a transfer leaves, with null as chequing`<br>`reads a transfer's from_account and drops one Gemini puts on any other type` |
| Income | An income source can name the account its income lands in (`deposit_account_id`, set in the seed overlay; null is chequing), and only an account that exists | `let an income source name the account its income lands in`<br>`reject %s` |
| Funding | An expense has a funder (self unless someone else paid); income and transfer have none | `defaults expense funded_by to self when Gemini returns null`<br>`someone else paying is saved with them as the funder`<br>`records who paid when someone else funded it`<br>`keeps the name on expenses and drops it otherwise`<br>`omits Funded by on income even when extraction still has a leftover value`<br>`omits Funded by on transfer`<br>`golden:paid-by-family` |
| Notes | A note in the owner's words, with spelling, typos, punctuation and grammar fixed and nothing added, is shown on the card and written to `transactions.notes` | `writes the note to transactions.notes`<br>`shows the note under the description, and no Note line without one`<br>`asks Gemini for a nullable note in the owner's words`<br>`asks Gemini to copy-edit the note lightly and add nothing`<br>`a text purchase shows a card, and Confirm saves it with its date and reason`<br>`reports a note that keeps a typo, misses a correction, or grows too long`<br>`golden:text-with-note` |
| Tags | A receipt caption that tags one item puts that tag on that line only: the card shows it indented under the line, and Confirm writes it to that line (`transaction_item_tags`); a line tag missing from the Tags list is dropped and the card warns instead of blocking Confirm (one that reaches Confirm anyway rolls it back), and a card saved before line tags resends with `/pending` and confirms with none | `a receipt caption that tags one item saves that tag on that line only`<br>`shows a line's own tags under that line only`<br>`a line tag missing from the Tags list is dropped with a warning, and the card still confirms`<br>`drops a line tag missing from the Tags list, even on every line, and warns instead of blocking`<br>`writes a line's own tags on that line only, and the header's on the transaction`<br>`confirms a row stored before line tags, with no tags on its lines`<br>`/pending resends a card saved before line tags, and it confirms with none on its lines`<br>`rolls back Confirm on a line tag that is not in the Tags list`<br>`keep a line's own tags once each, and drop them with the line`<br>`reports header tags and each line's own tags, once a tag on every line counts as the header's`<br>`golden:receipt-line-tag` |
| Tags | Whole-message context tags every line: it is stored once, on the transaction, even when the model copies it onto each line, and a line never repeats a header tag; a card saved before that rule confirms with a repeated header tag stored once | `whole-message context tags every line, stored once on the transaction`<br>`confirms a row stored before tags were deduplicated, with a repeated header tag`<br>`moves a tag that every line carries to the header`<br>`keeps a line tag on that line only, without repeats or a header tag`<br>`golden:receipt-line-tag` |
| Tags | Income and transfer tags stay on the transaction, which has no lines | `income and transfer tags stay on the transaction, with no lines to tag`<br>`writes income and transfer tags on the transaction`<br>`keeps income and transfer tags on the header, once each` |
| Tags | An Edit sends each line's tags back with the correction, keeps them unless the correction changes them, and a moved line tag shows on the card and is saved on its new line; a card saved before line tags goes back with no tags on its lines | `an Edit can move a line tag to another line, and the card and the save follow it`<br>`an Edit of a card saved before line tags sends its lines with no tags, and takes the new ones`<br>`sends each line's tags so a correction can keep or change them, and returns the new ones` |
| Gemini | Text, photo, voice and Edit prompts ask for each line's own tags, before its bucket, in the same one request | `asks text, photo, voice and Edit for each line's own tags, before its bucket`<br>`returns each line's own tags, and none for a line without` |
| Multi-event | Purchases at different places split into one card each, labelled "(i of n)" | `two stores become two labelled cards, each saved on its own Confirm`<br>`inserts two events in one batch and sends two labelled cards in order`<br>`labels the header (i of n) only when a message has several events`<br>`golden:two-stores` |
| Batch position in acks | Confirm and Discard on a card from a batch of 2+ reply "Saved. (k of n)" / "Discarded. (k of n)" (toast and chat), matching the card header; a single card or a card resent by `/pending` keeps the plain ack | `discarding the second of two cards says which one, in the toast and the chat`<br>`two stores become two labelled cards, each saved on its own Confirm`<br>`a card that never arrived comes back with /pending and can be confirmed`<br>`adds the card's (k of n) to an ack only when its header carries one` |
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
| Failures | `/pending` resends the card of every row of that chat still pending, oldest first, without asking Gemini, even while a card waits; with none it says "No pending cards." | `a card that never arrived comes back with /pending and can be confirmed`<br>`with nothing pending, /pending says so and asks Gemini nothing`<br>`/pending while a card waits for a date resends the others and the wait goes on`<br>`a resent card that fails to send does not stop the next one`<br>`lists the chat's pending rows oldest first, skipping handled, waiting and other chats' rows` |
| Merchants | `/addmerchant Name` adds a merchant (no Confirm: the typed command is the confirmation, and it writes a lookup, not the ledger); the next extraction lists it to Gemini and Confirm links it. `/delmerchant Name` removes one that no transaction uses, and the next extraction no longer lists it. Matching ignores case | `a merchant added from Telegram is listed in the next extraction and linked on Confirm`<br>`a deleted merchant is not listed in the next extraction and is not linked`<br>`adds a merchant with no aliases, and the next taxonomy load has it`<br>`deletes a merchant that no transaction uses, whatever the case`<br>`will not add a name that matches a merchant in another case, and reports the existing spelling` |
| Merchants | `/delmerchant` on a merchant that saved transactions use hides it: it stays on them, the next extraction leaves it out, a later Confirm does not link it, and the reply says how many transactions keep it | `a merchant on saved transactions is hidden: it stays on them, the next extraction leaves it out, and Confirm does not link it`<br>`hides a merchant that saved transactions use: it keeps their links, leaves the taxonomy, and a later Confirm does not link it`<br>`answers an add and a delete in each outcome, with 'transaction' singular for one` |
| Merchants | `/addmerchant` on a hidden merchant's name, in any case, unhides it, and the next extraction lists it again | `/addmerchant on a hidden merchant brings it back to the next extraction`<br>`adding a hidden merchant's name, in any case, unhides it and links what was confirmed while hidden` |
| Merchants | A new or unhidden merchant is linked to every saved transaction with no merchant whose stored extraction, or the business a re-read of its archived photo or voice note found (`ingestions.media_merchant`), names it (spaces collapsed, case ignored), and the reply says `Linked N past transactions that name it exactly.` A transaction that already has a merchant is never changed | `/addmerchant links past saved transactions that named it and leaves already-linked ones alone`<br>`/addmerchant on a hidden merchant brings it back to the next extraction`<br>`adding a merchant links past transactions whose extraction names it, ignoring case and spaces, and leaves linked ones alone`<br>`adding a hidden merchant's name, in any case, unhides it and links what was confirmed while hidden`<br>`links past transactions whose re-read media names the merchant, and leaves linked and pending ones alone`<br>`/addmerchant links a receipt photo whose re-read media names it, though its extraction named no merchant`<br>`answers an add and a delete in each outcome, with 'transaction' singular for one` |
| Merchants | After `/addmerchant X`, transactions with no merchant whose message text, caption or description mentions X as a whole word or phrase (key rules; "Lark" never matches "Larkspur") are not linked but offered in a review message, newest first, 8 at a time: one toggle button per row (`☐ Sep 15 · 12.50 · "words around the match"`), then Link selected, Select all and Skip, and More › when more remain. A tap ticks or unticks a row and writes nothing; Link selected links only the ticked rows that still have no merchant and edits the message to `Linked N of M to X.` with no buttons; Skip removes the buttons and writes nothing; More › sends the rows after the last one shown. A row with a merchant is never offered or changed, a merchant deleted or hidden before the tap links nothing, and a tap from off the allowlist does nothing | `links exact names at once, and offers mentions in a message, caption or description one by one`<br>`a tap ticks a mention without writing, and Link selected links only the ticked ones`<br>`Select all ticks every mention, and Link selected links them all`<br>`Link selected with nothing ticked asks for a pick and writes nothing`<br>`Skip removes the buttons and writes nothing`<br>`matches the name as a whole word or phrase, not inside a longer word`<br>`a transaction that already has a merchant is never offered`<br>`a mention linked elsewhere between the offer and the tap keeps its merchant`<br>`a mention offered for a merchant deleted before the tap is not linked`<br>`shows 8 mentions at a time; More sends the next ones and leaves the first message's picks alone`<br>`More says so when the rest were linked in the meantime`<br>`a review tap from a chat that is not on the allowlist does nothing`<br>`finds the name as a whole word in a message, a caption or a description, apostrophes and case aside`<br>`matches a name with regex characters literally in Postgres`<br>`offers only rows with no merchant, a page at a time after the last row shown`<br>`finds nothing for a hidden merchant`<br>`links the picked rows that still have no merchant, and nothing for a hidden or missing merchant`<br>`shows the date, amount and the words around the match, from the message before the description`<br>`cuts long text to a window around the match, marking what it cut`<br>`falls back to the description when the match cannot be placed`<br>`is the merchant key between non-word characters, with regex characters escaped`<br>`puts one toggle per mention, then Link selected, Select all and Skip, and More only when more remain`<br>`flips one toggle, ticks all, reads the ticked ids, and drops More`<br>`reads each tap's action and ignores anything else`<br>`summarises a link, naming picks that already had a merchant` |
| Merchants | Link selected links a transaction only if it still mentions the merchant by the review's own match (message text, caption or description), so an id the review never offered is never linked | `links only rows that mention the merchant, whatever ids the tap carries` |
| Merchants | A tick or Select all on the mention review is answered only after its keyboard edit, so the spinner holds until the tick shows; a Link selected whose picks all already have a merchant (a retried or repeated Link) keeps the message's summary and pops `Nothing linked: those already have a merchant.` | `answers a %s review tap only after the keyboard is edited, so the spinner holds until it shows`<br>`a retried Link selected keeps the first summary instead of reporting zero linked` |
| Merchants | If finding or sending the mention review fails after `/addmerchant` has replied, the error is logged and the request still succeeds, so Telegram does not resend the command | `answers /addmerchant with 200 when the mention offer fails after the reply, so Telegram does not resend it` |
| Merchants | An edit Telegram refuses as "message is not modified" (a retried or double tap on a review that already shows the result) counts as done, so the request does not fail and Telegram does not resend the tap; any other refused edit still fails | `treats Telegram's 'message is not modified' as done, so a retried tap does not fail`<br>`still throws any other refused edit` |
| Merchants | The one-off media backfill (`npm run backfill:media-merchant`, run by hand, never CI or the Lambda) reads only confirmed single-event photos and voice notes whose extraction named no merchant and whose `media_merchant` is unset, and only when that row is event 0 (no earlier event was dropped); it asks Gemini only which businesses the media names and stores the one named, skipping and counting media that names several or a name over 100 characters; `--dry-run` prints the proposed names and counts and writes nothing, `--limit N` caps the rows, a failed row is counted and skipped, and a re-run skips rows already set | `asks Gemini only which business the media names, with the media inline, and stores the answer`<br>`a dry run reads and prints the proposed names but writes nothing`<br>`passes the limit to the candidate query, and no limit as null`<br>`counts a missing object or a Gemini error as failed, writes nothing for it, and goes on`<br>`treats a blank or non-text answer as no business`<br>`reads --dry-run and --limit N, and refuses anything else`<br>`reads only confirmed single-event photos and voice notes with no merchant, once`<br>`skips media that names several businesses, or a name too long to be a merchant, and counts them`<br>`a message that dropped an event is read only through its first event, and skipped when it names two businesses` |
| Merchants | Merchant names match with case, spacing and apostrophe style ignored (`’ ‘ ´` and backtick read as `'`), everywhere: link-on-add, the frequent-merchant hint, the duplicate-name check, `/delmerchant`, Confirm's merchant lookup and the card's "not in lookup" warning. The TypeScript and SQL keys give the same result | `finds a listed merchant whatever its case, spacing or apostrophe`<br>`makes case, spacing and apostrophe or quote variants one key`<br>`the TypeScript key and the SQL key agree`<br>`a name differing only by apostrophe style is the same merchant`<br>`Confirm links a merchant named with another apostrophe style, but not a hidden one`<br>`counts apostrophe styles as one name, and finds a lookup row spelled with another` |
| Merchants | Adding a merchant also links a transaction with no ingestion (a history import) and no merchant when its whole description equals the name; a longer description, or a row with an ingestion, is never matched that way, and an existing link is never changed | `adding a merchant links imported rows whose whole description is its name, typographic apostrophes and case aside`<br>`never matches an imported row by part of its description`<br>`an imported-row match applies only to rows with no ingestion: a bot row is matched by its extraction`<br>`links past transactions whose extraction names the merchant with a curly apostrophe`<br>`/addmerchant links an imported row named with a curly apostrophe, and leaves a longer description alone` |
| Merchants | `/addmerchant` on a visible merchant links what is still unlinked and replies `Already a merchant: X. Linked N past transactions that name it exactly.` (plain `Already a merchant: X.` when none link) | `adding a name that exists links what is still unlinked and reports the count`<br>`/addmerchant on an existing merchant links what is still unlinked, and says so only when it did`<br>`answers an add and a delete in each outcome, with 'transaction' singular for one` |
| Merchants | `/merchants` lists the visible ones sorted, with the hidden count (cut to Telegram's limit), and a command with an empty, over-long or comma name, or an unknown one to delete, gets a hint and writes nothing | `/merchants lists them sorted, and a command with no usable name gets a hint, not a write`<br>`lists the visible merchants sorted by name, and counts the hidden ones`<br>`reports a name that is not a merchant`<br>`lists the visible merchants with their count and the hidden count, says so when there are none, and cuts a list Telegram would refuse`<br>`collapses spaces in a merchant name and refuses an empty, over-long or comma name with a reason` |
| Merchants | A card whose merchant is in no lookup row (visible or hidden, any case) while 3 or more saved purchases from other messages name it (spaces collapsed, case ignored) shows one `💡` line suggesting `/addmerchant Name`; Confirm stays. Fewer than 3, a listed or hidden merchant, no merchant, or a name `/addmerchant` would refuse shows none. Pending and discarded cards and the card's own message do not count. Sending the command and then tapping Confirm on that card links the merchant | `a card whose merchant three saved purchases name, and no merchant row, suggests /addmerchant and keeps Confirm`<br>`two saved purchases are not enough`<br>`a merchant already in the lookup gets no hint, however often it was bought`<br>`a hidden merchant gets no hint: hiding it was the owner's choice`<br>`a card with no merchant gets no hint`<br>`sending /addmerchant for the hint, then Confirm on the same card, links the merchant`<br>`counts confirmed purchases that name the card's merchant, ignoring case and spaces`<br>`is empty below the minimum, and counts neither pending, discarded nor the card's own update`<br>`is empty for a merchant in the lookup, in any case, and for a hidden one`<br>`is empty for a card with no merchant`<br>`stops once the merchant is added`<br>`names the merchant, the count and the command to send`<br>`says nothing without a frequent merchant, or for a name /addmerchant would refuse`<br>`shows a merchant hint after the warnings and before the Confirm line`<br>`adds a hint to add a merchant bought from often, and keeps Confirm` |
| Merchants | If the hint's lookup fails, the saved card is still sent, without the hint | `sends a saved card without the hint when the merchant check fails` |
| Telegram | A message can be sent or edited as Telegram HTML with link previews off, and every name or description in one is escaped; the journey fakes refuse HTML Telegram would refuse (an unsupported, unclosed or misnested tag, an unescaped `&`, `<` or `>`) and count only the visible text towards the 4096 limit | `sends HTML with link previews off and keeps the buttons an edit passes`<br>`escapes &, < and > for an HTML message`<br>`count only the text an HTML message shows towards Telegram's limit`<br>`reject HTML with an unsupported tag, an unclosed tag or an unescaped character`<br>`a name or description with &, < or > is shown as typed in every HTML screen` |
| Commands | A known slash command (every one in the menu) runs before the wait, so it is never taken as a date or a correction, and never reaches Gemini; one from a chat off the allowlist is ignored | `a merchant command while a card waits for a correction is not sent to Gemini`<br>`a merchant command from a chat that is not on the allowlist does nothing`<br>`every command in the menu is answered without asking Gemini`<br>`reads a known slash command with or without @botname, in any case, and its argument`<br>`returns nothing for plain text, an unknown command, or a longer word` |
| Commands | The Telegram command menu is built from the same table the handler routes on, in the shape Telegram accepts, and is registered with `setMyCommands` | `lists exactly the commands the handler routes on, in Telegram's allowed shape`<br>`registers that menu with setMyCommands` |
| Gemini | A 503 or 429 retries down the model chain; other errors do not retry | `retries a 503 on the fallback model and records which model answered`<br>`retries a non-JSON 503 body too`<br>`gives up after three attempts with the HTTP status in the error`<br>`moves to the next model on a 429, since free-tier quota is per model`<br>`does not retry a bad request` |
| Gemini | A card read by the Lite model warns to check categories and buckets, and only then | `only the lighter model answered: the card says to check categories and buckets`<br>`flags a card that a Lite model read, and only then` |
| Gemini | A message is one request with the buckets included, and the rules never reach the logs | `makes one call that returns buckets, with the rules after the taxonomy`<br>`reads needs from the item and maps anything else to wants`<br>`never logs the system prompt, so the rules stay out of CloudWatch`<br>`sends the API key in a header, not the URL` |
| Gemini | Token usage is stored on the first event of a message only | `persists the valid event, previews the invalid one without buttons, and moves usage` |
| Taxonomy | The taxonomy comes from the database and rejects a subcategory or item type that is not in it | `returns the generic seed plus the example overlay, nothing personal`<br>`rejects an item_type from a different category than the subcategory`<br>`accepts a balanced expense with live taxonomy` |
| Eval | A golden case whose Gemini request is byte-for-byte the one recorded as passing replays its recording through today's code instead of calling Gemini | `answers every Gemini request with the recording, without the network, and keeps the bodies`<br>`keeps the body and puts fetch back when the current code rejects the recording`<br>`changes when one byte of the body or any model in the chain changes`<br>`rewrites only the recording and the request hash, in the file's own format`<br>`marks a replayed case and counts it apart from live answers` |
| Eval | The nightly run asks Gemini every case, case i starting on model (i + day) mod chain length, and reports each 429's quota limit | `starts case i on model (i + day) mod chain length and falls through the rest in order`<br>`covers every model with every case over chain-length nights`<br>`sends each request to the model the route picks and reports that model`<br>`keeps each 429's quotaValue by model and quota`<br>`lists the quota limits Gemini reported in its 429s` |
| Safety | Tests refuse any database that is not on this machine, and the read-only role writes nothing | `refuses a database that is not on this machine`<br>`can read every public table and write none of them`<br>`is refused a write when it tries one` |
| Ledger | Every expense's lines sum exactly to its amount; a line moved by 0.01 fails the `dbt` job | `dbt:expense_lines_sum_to_header` |
| Ledger | Every expense has at least one line, and income and transfers have none | `dbt:expense_has_lines`<br>`dbt:no_lines_on_income_or_transfer` |
| Ledger | A line's item type belongs to the same category as its subcategory | `dbt:item_type_matches_subcategory_category` |
| Ledger | An expense has a funder, and income and transfers have none; a transfer names the account it leaves, the one it enters or both (null is chequing), never the same one twice, so a withdrawal passes; only a transfer has a from account | `dbt:expense_funding_rules`<br>`dbt:transfer_has_account` |
| Ledger | Warnings, not failures: a line tag that repeats its header tag, a transaction with two confirmed ingestions, a date past Toronto's tomorrow | `dbt:line_tag_not_on_header`<br>`dbt:one_confirmed_ingestion_per_transaction`<br>`dbt:occurred_on_not_in_future` |
| Ledger | A transaction links to at most one recurring series, of its own kind only; linking sets `is_recurring` and unlinking clears it, while an unlinked insert keeps the flag it was given until migration 0017; a deleted series unlinks its transactions; a transaction is never both linked to and excluded from a series; pauses of a series never overlap; the nightly checks production | `links a transaction to a series of its own kind and refuses another kind`<br>`linking sets is_recurring and unlinking clears it`<br>`keeps a legacy flag on an unlinked insert and through merchant linking, and lets it be cleared`<br>`deleting a series unlinks its transactions and clears their flag`<br>`refuses a pause that overlaps another pause of the series`<br>`refuse a recurring series with %s`<br>`dbt:recurring_link_matches_series_kind`<br>`dbt:recurring_link_not_excluded`<br>`dbt:recurring_pauses_do_not_overlap` |
| Recurring | Cadence detection reads calendar slots, not intervals: monthly, month-end, biweekly, semi-monthly and quarterly histories get their cadence and anchor, a month never logged lowers coverage but does not change the cadence, twice-a-week shopping is not proposed, a cadence needs a full period of history to be suggested, and a declared cadence fits even one payment | `detects %s`<br>`proposes a regular series with enough history, and not twice-a-week shopping`<br>`reads a gap in logging as a missing payment, not a change of cadence`<br>`needs a full period of history before it suggests a cadence`<br>`fits the owner's declared cadence to a single payment`<br>`suggests monthly for any regular monthly series with up to two days of jitter` |
| Recurring | Each expected payment has a window (±2 spreads, weekend starts move to Friday and weekend ends to Monday) and counts as missed only after the window and its grace; a paused period is never missed (a slot on the pause's first day is paused, one on its resume day is expected), a skip settles one payment, a payment logged during a pause counts and is flagged, a second payment in one slot is reported | `predicts %s`<br>`counts a missed payment only after its window and grace`<br>`never counts a paused slot as missed`<br>`pauses a slot whose centre is the pause's first day, and expects one on its resume day`<br>`lets a skip settle the one payment that will not happen`<br>`counts a payment logged during a pause as met and flags it, and reports a second payment in one slot`<br>`never counts a slot inside a pause as missed, for any monthly series and pause` |
| Recurring | A series' usual amount is the median with a band (5 %, three robust spreads or 1.00 from four payments; 10 % or 1.00 below), none when the amount varies, and an amount outside it is reported in signed cents | `is the median plus or minus 5 %, three robust spreads or 1.00 from four payments on`<br>`is 10 % or 1.00 below four payments, and absent when the amount varies` |
| Recurring | Descriptions match as word sets, ignoring case, order, digits, month names and filler words, so a reworded bill with no merchant still matches its series (by name, keyword or any linked description) when the amount or the date agrees; subcategory alone is a weak match; income matches by source, transfers by accounts; an excluded payment, one in another series or of another kind never matches | `compares descriptions as word sets: case, order, spacing, dates and filler words do not matter`<br>`keeps different payments apart`<br>`matches %s`<br>`never offers a payment the owner excluded from the series`<br>`matches wording seen only in the series' history, not just its name`<br>`matches income by source and a transfer by its accounts, whatever the wording`<br>`matches by merchant, and by a keyword the owner added`<br>`picks the stronger match, then the closer slot, then the closer amount` |
| Recurring | The detector proposes regular unlinked groups (income by source, transfers by accounts, expenses by merchant or by similar descriptions at a similar amount) over the last 400 days, never twice-a-week shopping, a dismissed group (or one dismissed under similar words) or one already tracked; detection does no I/O | `groups reworded descriptions with no merchant and proposes a regular one`<br>`keeps a different amount under the same words apart`<br>`proposes income by source, transfers by accounts and expenses by merchant`<br>`does not propose twice-a-week shopping, a dismissed group or one already tracked`<br>`reads only the last 400 days, and skips descriptions with no words`<br>`does no I/O: pg is mocked to throw on import and the network on call` |
| Recurring | `/recurring` lists the series grouped by kind (16 a page, More › and ‹ Back between pages), each with its cadence and anchor, usual amount (or `varies`), and its next window, the count not logged, or its pause; a tap on one edits the message in place into its detail: keys, cadence, band, payments since and last, next window and the dates not logged; money is formatted from cents | `/recurring lists each series with its next window and opens its detail in place`<br>`says so when nothing is tracked yet`<br>`shows 16 series a page, two buttons a row, with More › to the rest`<br>`describes a %s cadence as %j → %s`<br>`formats money from cents with thousands separators and no float`<br>`formats days and windows, within a month and across one` |
| Recurring | Pause asks from when (today, or the first payment not logged) and until when (until resumed, a date one or three months on, or a date the owner replies with, where a month and day alone is its next occurrence after the later of the start and today and a day not after the start is refused: how a series that bills again from a known later date is told not to expect a payment before then; dates outside the current year show their year), and only that last answer writes one dated pause; a slot inside it is never not logged; Resume ends it on that day (or removes it if it began that day); a Today button (pause from, resume, next payment not until) means the day it is tapped, not the day it was drawn, also from a payment logged during the pause; a repeated tap or reply writes nothing, and one racing the first is answered as already paused; a pause overlapping another is refused with a hint and nothing is written | `pausing a series since its last payment stops it being missed`<br>`a pause that overlaps an earlier one is refused and nothing is written`<br>`resuming from a payment logged during the pause counts the pause up to it`<br>`a series that bills again from a later date is paused until the day the owner types, never missed before it`<br>`a typed end with no year is its next occurrence after today, even for a pause that began over a year ago`<br>`today or yesterday typed for a pause that starts today is refused, not read as next year`<br>`reads a typed pause end: a month and day is its next occurrence after the later of the start and today`<br>`a paused series shows its pause in the list and detail`<br>`writes one dated pause, repeats as already, refuses an overlap, and resumes on a date`<br>`resuming on the day a pause began removes it`<br>`a Today button tapped days after it was drawn uses the day of the tap`<br>`a pause that waits on the same pause from another tap is already paused, not an overlap` |
| Recurring | Rename is a reply to a prompt that names the series by id (no waiting state; routed before the date or correction wait), 1 to 60 characters, refused when another series has the name in any case, and keeps the links; Delete asks first, then deletes the series, unlinks its payments and clears their `is_recurring`, and a repeated Delete writes nothing | `renaming by replying to the prompt keeps its links`<br>`a rename reply while a card waits for a date renames the series and leaves the card waiting`<br>`a rename reply for a deleted series says so`<br>`deleting a series asks first, then clears is_recurring on its payments`<br>`renames, refuses a taken name, and reports a series that is gone`<br>`deleting a series unlinks its payments, clears their flag, and a second delete finds nothing` |
| Recurring | Logging an expense wins over a /recurring prompt: only a text reply to the bot's own rename or pause-end prompt, sent within 15 minutes of it, is taken as the answer; a photo, voice note, audio, document or caption, a reply to anything else, a stale prompt, text with money in it (a decimal amount such as 12.50 or 4,50, or a currency marker next to a number: $5, 5$, 5 dollars), or a date reply that is no date but reads as an expense (a number next to a non-date word) goes on to extraction as usual; plain digits in a name ("Internet 2") still rename | `a receipt photo sent as a reply to a rename prompt is still saved as an expense`<br>`an expense typed as a reply to a pause prompt is saved, not taken as the date`<br>`a long expense typed as a reply to a rename prompt is saved, not refused as a name`<br>`lunch 12.50 sent as a reply to a rename prompt is saved as an expense, and Internet 2 still renames`<br>`reads a decimal amount or a currency marker as money, and plain digits in a name as none`<br>`a reply to a prompt older than 15 minutes goes to extraction`<br>`leaves %s to extraction`<br>`reads an amount next to a non-date word as an expense, and a date as none` |
| Recurring | ➕ Add lists the newest saved payments in no series (8 a page, More › and ‹ Back); picking one shows the series it would start: default name (merchant, else income source, else the description without digits or month names, numbered when taken), its similar past payments and the cadence they suggest listed first and ticked (or "not enough to tell"), and an Amount varies toggle that only edits the keyboard; a cadence tap creates the series with the payment's keys (expense merchant and largest line's subcategory, income source, transfer accounts), links only that payment, and offers a pause until a typed date for one that bills later; a double tap, even one racing the first, creates nothing more and names the series; no Gemini call | `adding from a saved transaction suggests monthly and links it`<br>`a payment with too little history asks for the cadence, and amount varies is stored`<br>`names it after the merchant, the income source, or the description without dates, and numbers a taken name`<br>`flips amount varies in the keyboard and in every cadence button, and nothing else`<br>`an add screen for a payment already in a series, or gone, says so`<br>`pages the saved payments 8 at a time, with More › and ‹ Back`<br>`makes a series from a saved transaction with its keys and links that transaction`<br>`a second tap on the same transaction creates nothing and names its series`<br>`a create that waits on another tap's create names the series that tap made`<br>`refuses a name another series has, in any case, and writes nothing` |
| Recurring | Every new series opens a review of all history, and 🧹 Review (on the list, on a series' detail, after Later) reopens it: a series' unresolved candidates (in no series, not excluded, a strong or weak match), newest first, 8 at a time, strong and ⚑ previously flagged rows pre-ticked and weak rows unticked; a toggle or Select all only edits the keyboard and rewrites Apply's label (`✅ Link 5 · ignore 3`), Later removes the buttons, and nothing is written until Apply, which in one statement links the ticked rows still in no series (re-checking kind and hard key), records an exclusion for each shown but unticked row so it is never offered again, and moves on to the next page or the series' totals; a payment in another series is never offered or taken; a repeated Apply writes nothing and keeps the screen | `Apply links the ticked payments and never offers the unticked ones again`<br>`a double tap on Apply links nothing twice and keeps the screen the first tap left`<br>`a toggle only edits the keyboard and writes nothing`<br>`a payment already in another series is not offered`<br>`shows 8 at a time, and Apply moves on to the rest`<br>`label Apply and Clear with what they will write, from the ticks`<br>`links the ticked rows, records an exclusion for the shown but unticked ones, and repeats as a no-op`<br>`never takes a row from another series, never links another kind or income source, and never excludes its own member`<br>`does nothing when the series is gone` |
| Recurring | Legacy flags: rows flagged recurring with no series are counted on `/recurring` (`⚑ N flagged, no series`) and listed 8 at a time, each with a toggle and ➕; Clear flag on ticked (k) clears only ticked rows still in no series and asks for a tick when none is, a repeat clears nothing, and ➕ makes a series from that row through the add flow | `a flagged row with no series can have its flag cleared`<br>`clears the flag only on picked rows in no series, once` |
| Recurring | Detector proposals are counted on `/recurring` and listed under 🔎 Suggestions with cadence, payment count and usual amount; Track opens the add flow on the newest payment and its review pre-ticks the rest; Not recurring records the group in `recurring_dismissed` so it is never proposed again, and a repeat writes nothing | `a suggestion dismissed as not recurring is never suggested again`<br>`tracking a suggestion adds it and reviews its payments ticked`<br>`records a dismissed group once` |
| Recurring | Every `/recurring` button's data parses back to its action and fits Telegram's 64 bytes with a ten-digit series id; other data is not a recurring tap | `reads every button's action, and nothing else` |
| Recurring | Confirm on a card that proposed a series (`cr:<card>:<series>`) links the new transaction to it, which marks it recurring; `cx:` saves it in no series and records that it is not that series, in the same database transaction. The series is re-read and key-share locked first: one deleted (even while Confirm runs), of another kind, or no longer matching the payment's income source or accounts saves the payment in no series, Confirm still succeeds, and the reply says it was not linked (a `cx:` card, which asked for no link, says nothing). A double tap links once. Gemini's `is_recurring` guess is no longer saved: the flag follows the link | `links the new transaction to the series the card showed, which marks it recurring`<br>`links income and transfers to a series of their kind and hard key`<br>`saves a payment the owner said is not that series unlinked, and records the exclusion`<br>`no longer saves Gemini's recurring guess on a transaction in no series`<br>`saves the payment unlinked when its series was deleted, is another kind or no longer fits`<br>`a series deleted while Confirm runs leaves the payment saved, unlinked`<br>`a double tap on Confirm saves and links once`<br>`Confirm on a card with a series links it (cr) or excludes it (cx), and says when it could not link`<br>`Confirm after the proposed series was deleted saves the payment unlinked and says so`<br>`a double tap on a card's Confirm saves and links once` |
| Recurring | Fix date or Edit clears the old card's buttons before asking, so its Confirm (which carries the series proposed for the old reading) cannot save the corrected payment linked to that series; the corrected card proposes its own. A failed clear is logged and the flow goes on | `Edit clears the old card's buttons, so its Confirm cannot link the corrected payment to the old series`<br>`Fix date clears the old card's buttons too`<br>`discarding the waiting card lets another card wait` |
| Recurring | A card that can be confirmed is matched against every series, with no Gemini call: a strong match (design §D.1) names the series on the card's `Recurring:` line and adds a last button row `↻ <series> ✓`, and Confirm links the payment to it; income matches by source and transfers by accounts. Tapping the row only edits the keyboard: it reads `↻ not <series>`, and Confirm then saves the payment in no series and excluded from it, so its review never offers it again. A weak match or none proposes nothing: the line reads `Recurring: no`, or `Recurring: not tracked yet` when Gemini called it recurring, and Confirm saves it as not recurring. The payment's names resolve to the ids Confirm saves; the callback data is at most 50 bytes with a ten-digit series id | `a payment matching a series is linked on Confirm`<br>`toggling the series off saves it unlinked and it is not offered again`<br>`a payment matching no series proposes none and is saved as not recurring`<br>`an income card names the income series it matches and Confirm links it`<br>`a transfer card names the transfer series it matches and Confirm links it`<br>`proposes nothing for a weak match, another kind or no series`<br>`picks the closer of two series the payment matches`<br>`names the series and its note, and otherwise Gemini's guess as a hint`<br>`links on Confirm with a toggle row, and the toggle swaps Confirm and its label only`<br>`keeps a name starting with not, and a long one, through toggles`<br>`proposes no series on a card without Confirm, and fits 64 bytes with a ten-digit series id`<br>`reads a card's payment with the ids Confirm would save: merchant by key, largest line, source, accounts` |
| Recurring | An amount outside the proposed series' usual band adds one note line (`↻ Phone bill · usually 45.00; this is 61.25 (+16.25)`) and keeps Confirm; a series whose amount varies has no band and no note | `an amount outside the usual band adds a note and keeps Confirm`<br>`proposes a strong match, with a note only outside its band` |
| Recurring | A payment saved in no series (no match, turned off, or its series gone) that Gemini called recurring gets one button on the `Saved.` reply, `↻ Track as recurring` (`r:at:<transaction>`, 41 bytes), which edits that reply into `/recurring`'s add flow for the payment; a cadence tap there creates the series and links it, with no Gemini call. This is how a series with no history is declared at its first charge. A linked payment, or one Gemini did not call recurring, gets a plain `Saved.` | `a payment Gemini calls recurring but no series matches offers Track as recurring, which opens the add flow`<br>`a linked payment, or one Gemini does not call recurring, gets a plain Saved`<br>`a payment excluded from the proposed series can still be tracked as its own`<br>`reports a payment saved in no series as looking recurring only when Gemini called it so` |
| Recurring | A failed series match still sends the card, with `Recurring: no` and Confirm; a card sent before its series existed (Confirm `c:`) saves the payment in no series | `sends a saved card without the series when matching fails`<br>`a card sent before series confirms with c: and links nothing` |
| Marts | `fct_transactions` drops and doubles no ledger line: per type, its amounts sum to the ledger's expense lines and income and transfer headers | `dbt:fct_amount_reconciles_to_ledger` |
| Marts | Every metric of every month in `fct_monthly_summary` equals the contract's reference SQL run straight over `public`, months zero-filled; a mart metric off by 0.01 fails the `dbt` job | `dbt:monthly_summary_matches_hand_written_sql` |
| Marts | The fixture's sample month 2026-06 has the values worked out by hand from the fixture, including interest paid into savings (`savings_income`), a withdrawal (`withdrawals`, adding to `unallocated_cash`) and a move between two accounts (in no metric) | `dbt:fixture_sample_month_expected` |
| Marts | Needs plus wants is spend and fixed plus variable needs is needs, every month; the category months sum to the monthly summary | `dbt:needs_plus_wants_equals_spend`<br>`dbt:category_month_sums_to_summary` |
| Marts | The MetricFlow metrics are exactly the contract's: a metric in the YAML but not in SEMANTIC_LAYER.md, or the reverse, fails the `dbt` job. `mf query` gives every metric of every month in `fct_monthly_summary` (money to the cent, ratios within 0.0001); `spend` without its self-funded filter fails, naming the metric and month and printing no value | `ci:mf query matches fct_monthly_summary for every contract metric`<br>`ci:spend without its self-funded filter fails check_metrics, naming spend and the month, with no values`<br>`ci:a metric in the YAML but not in SEMANTIC_LAYER.md fails check_metrics` |

## Running each layer

Run from `lambda/`.

| Layer | Command | Needs |
|---|---|---|
| Unit | `npm run test:unit` | nothing |
| Integration and journeys | `npm run test:integration` | `TEST_DATABASE_URL` |
| Everything | `npm test` | `TEST_DATABASE_URL`, or the database layers are skipped with a warning |
| Coverage floor | `npm run test:coverage` | `TEST_DATABASE_URL` |
| Eval (live Gemini) | `npm run eval` | `TEST_DATABASE_URL`, `GEMINI_EVAL_API_KEY` |
| Nightly eval (every case live, models rotated) | `EVAL_NIGHTLY=1 npm run eval` | the same |
| Needs/wants accuracy (local only) | `npm run eval:buckets` | see [below](#the-needswants-accuracy-check) |
| Inventory | `node scripts/check-inventory.mjs` (repo root) | nothing |
| dbt (staging, marts and their tests) | `dbt build` (from `dbt/`) | `TEST_DATABASE_URL` and the dbt virtualenv; see [below](#the-dbt-build) |
| Nightly dbt on production | `dbt build --exclude tag:fixture`, then `mf validate-configs` and `python scripts/check_metrics.py` (from `dbt/`) | the production `FINFLOW_DBT_*` variables; see [below](#the-nightly-dbt-build) |

A throwaway Postgres for the database layers: start Docker, run
`npm run db:up` in `lambda/`. Each checkout (worktree) gets its own container,
`finflow-test-db-<hash of the repo path>`, on a port in 54330-54429, so parallel
agents never share or stop each other's database. `db:up` prints the
`TEST_DATABASE_URL=...` to use; `TEST_DATABASE_URL=$(npm run -s db:url) npm test`
runs the suite against it. The harness recreates a `finflow_test` database on it
and refuses any other host. `npm run db:down` stops only this checkout's
container.

CI (`.github/workflows/ci.yml`) reports five jobs on every PR: `unit`,
`integration`, `eval`, `inventory` and `dbt`, and all five are required on
`main`. `inventory` runs the inventory check
and the coverage floor (lines 90, statements 90, branches 84, functions 98;
raise it, never lower it). The deploy workflow runs only after CI succeeds
on `main`, then POSTs a wrong webhook secret to the deployed Function URL
(read with `get-function-url-config`, never committed) and fails unless it
gets 401. That smoke step has no inventory row: it is not a test file.
A last deploy step reads the bot token from SSM, masks it, and runs
`npm run telegram:commands` to set the command menu. It is not a test either;
its payload is the unit-tested `commandMenu()`. A failure there turns the run
red but leaves the deployed code in place.

## The dbt build

`dbt/` is the semantic layer's dbt project (dbt-core and dbt-postgres,
pinned in `dbt/requirements.txt`, Python 3.12). Its tests are generic tests
in the models' YAML and singular tests in `dbt/tests/`, each a query that
returns the rows breaking one ledger invariant. `dbt build` runs every model
and test. It runs against a throwaway ledger, never production:
`dbt/scripts/test_db.py` refuses any host but this machine, rebuilds the
same `finflow_test` database the integration suite uses (every migration,
then the example seed), loads the synthetic fixture
`dbt/fixtures/synthetic.sql` (placeholder names only), and prints the
`FINFLOW_DBT_*` variables `dbt/profiles.yml` reads. dbt connects as
`finflow_dbt` (migration 0013) with a throwaway password the loader sets
(it sets one on `finflow_analyst` too),
so a build that needs more than that role's grants fails. Running either
suite rebuilds that database for itself.

```sh
cd lambda && npm run db:up && cd ../dbt
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt   # once
eval "$(TEST_DATABASE_URL=$(npm --prefix ../lambda run -s db:url) .venv/bin/python scripts/test_db.py)"
.venv/bin/dbt build
.venv/bin/mf validate-configs && .venv/bin/python scripts/check_metrics.py
```

Models: three staging views in schema `staging`, and four mart tables in
`marts` (`dim_date`, `fct_transactions`, `fct_category_month`,
`fct_monthly_summary`), all rebuilt in full every run.
`monthly_summary_matches_hand_written_sql` is the acceptance check: it runs
[SEMANTIC_LAYER.md](SEMANTIC_LAYER.md)'s reference SQL over `public` and
compares every metric of every month with the mart, printing month and
metric names only. `fixture_sample_month_expected` (tag `fixture`) checks
the fixture's 2026-06 against hand-worked literals; it means nothing on
production, so a run there uses `dbt build --exclude tag:fixture`. If you
change the fixture's June rows, redo the arithmetic in that test's header.

MetricFlow (`dbt-metricflow`, same requirements file) reads the semantic
model and the metrics in `models/marts/_marts.yml`. After `dbt build`,
`mf validate-configs` checks them against the database, and
`scripts/check_metrics.py` (stdlib and psycopg2) holds them to the contract:
the metric names in SEMANTIC_LAYER.md's metric table and in
`target/semantic_manifest.json` must be the same set, and `mf query` for
every metric by `metric_time__month`, over the mart's months, must equal
`fct_monthly_summary`: money to the cent, ratios within 0.0001, an empty mf
cell is 0 for money and null for a ratio. A mismatch prints the metric and
month only. `mf` finds `profiles.yml` in the working directory, so run both
from `dbt/`. After editing the metric YAML, parse with
`DBT_PARTIAL_PARSE=false`: dbt 1.12.6's partial parse can register an
edited metric twice.

### Browse the dbt docs locally

dbt's generated docs site shows each model's lineage graph and column
descriptions. It is not hosted anywhere (DECISIONS.md, 2026-10-30); you
generate and serve it on your machine, from the throwaway fixture database
after the build above, with the same `FINFLOW_DBT_*` variables in the shell:

```sh
.venv/bin/dbt build            # the catalog reads the built relations
.venv/bin/dbt docs generate    # writes target/index.html, catalog.json, manifest.json
.venv/bin/dbt docs serve       # http://localhost:8080; --port N to change it
```

`target/` is gitignored. The site covers lineage and column docs only: the
metric definitions stay in [SEMANTIC_LAYER.md](SEMANTIC_LAYER.md). Generate
it from the fixture, never from production: the catalog step reads the
database, and the site embeds what it finds. Stop the fixture database with
`cd lambda && npm run db:down` when you are done.

Extra SQL files given to `test_db.py` load after the fixture.
`dbt/fixtures/off_by_a_cent.sql` moves one receipt line by 0.01; with it,
`dbt build` must fail on `expense_lines_sum_to_header` and nothing else
(the marts downstream are skipped, not built).

The CI job `dbt` runs on every PR, against a `postgres:17` service:
`dbt build` on the fixture must pass; `finflow_analyst` (throwaway password
from the loader, the role's name) logs in, must find exactly the four
marts and read each, and must be refused `staging.stg_transactions` and
`public.ingestions`; with an `anon` role created and granted `SELECT` on
`public.transactions`, `dbt test --exclude tag:fixture` must fail
`data_api_roles_reach_nothing` and nothing else (the throwaway Postgres has
no Data API roles, so without this the guard would pass by finding none);
`mf validate-configs` and `check_metrics.py` must
pass; with `_marts.yml` edited on the runner (`perl`), `check_metrics.py`
must fail naming `spend` and 2026-06 and printing no value when `spend`
loses its self-funded filter, and must name a metric added to the YAML
alone; then `dbt build` with the variant
must fail, and `target/run_results.json` must name that one test as the
only failure; then, with `fct_monthly_summary.sql` edited on the runner
(`sed`) to move `transfers` by 0.01, `dbt build --exclude tag:fixture` must fail
`monthly_summary_matches_hand_written_sql` and nothing else. So a lines-sum
test or a reconciliation that stopped biting fails the job. A fixture
change cannot prove the reconciliation: both sides read the same ledger.
pip's download cache is keyed on `dbt/requirements.txt`.

## The nightly dbt build

`.github/workflows/dbt-nightly.yml` runs the dbt build against production
at 08:45 UTC (04:45 EDT, 03:45 EST), after Toronto's midnight all year, and
on demand (`gh workflow run dbt-nightly.yml`). It has no `pull_request`
trigger: its secrets `FINFLOW_DBT_HOST`, `FINFLOW_DBT_USER` and
`FINFLOW_DBT_PASSWORD` reach only the three steps that connect, never PR
code. Only `main` reaches production: a dispatch on another branch skips
the build job, so a branch's edited models never run there. It connects as `finflow_dbt` through Supabase's session pooler (port
5432) with `sslmode=verify-full` against `supabase/prod-ca-2021.crt`
(libpq's `PGSSLROOTCERT`), and runs `dbt debug --connection`, then
`dbt build --exclude tag:fixture` (every model, invariant and the
reconciliation to `public`; not `fixture_sample_month_expected`), then
`mf validate-configs` and `check_metrics.py`. The `finflow_analyst` login
check stays in the PR `dbt` job: that role's password is not a CI secret.

The log is public, so it shows names and statuses only. All of dbt's own
output (`dbt debug` included: row counts, failing-test counts, database
error text that can quote a row) and `mf`'s go to a runner file that is
never printed or uploaded; the log says whether the connection worked,
lists each node's status and unique id from `target/run_results.json`, and
`check_metrics.py` prints metric and month names. A failure, a step timeout
(connect 3, build 12, metrics 4 minutes) or a cancel opens one issue
labelled `dbt-nightly`, or comments on the open one, with a table naming the
failed nodes or checks and the run URL, never empty; the next pass closes
it. Without
the secrets (a fork, or before they are set) the build job is skipped and
the run is green.

To see the detail behind an issue, run the same commands from `dbt/` with
the production `FINFLOW_DBT_*` variables in your shell (keep them in the
gitignored `.env`, never in a tracked file), plus `FINFLOW_DBT_PORT=5432`,
`FINFLOW_DBT_SSLMODE=verify-full` and
`PGSSLROOTCERT=../supabase/prod-ca-2021.crt`.

## The eval and its key

`npm run eval` runs every golden case through the production extraction
code and checks Gemini's answer against the case's `expect`. It passes
without running when no path that changes the request or the judging moved
since the base commit.

Each case first builds its exact Gemini request with no network call, from
its `recorded` answer, and hashes it with the model chain
(`requestHash`). When that hash equals the case's `request_sha256`, Gemini
already passed that exact request, so the recording goes through today's
code and is checked against `expect`, with no Gemini call. Any other case
calls Gemini. The eval pins "today" to a fixed date so the request does not
change daily, and an edit case patches its base case's recording, so every
case is at most one request.

Add `-- --hashes` to write each live pass's request hash into its
golden's `request_sha256`, keeping `recorded` (the journeys assert on it).
`-- --record` also replaces `recorded` with the live answer; update the
journeys that quote it in the same commit. Locally the key comes from the
environment or the repo-root `.env`.

CI runs with `--hashes` but cannot commit, so after a PR's eval calls
Gemini, commit the hashes in the same PR (gh will not overwrite files, hence
the scratch directory):

```sh
gh run download <run-id> -n goldens -D /tmp/goldens
cp /tmp/goldens/*.json lambda/tests/golden/
```

The next push then replays those cases without a call.

Key setup, once:

1. In Google AI Studio create a project **separate from the production
   bot's**, and an API key in it. Free-tier quota is counted per project (20
   requests a day on each Flash model), so a key from the production project
   would spend the bot's daily requests.
2. Add the key as the `GEMINI_EVAL_API_KEY` Actions secret. To run the eval
   locally, export it or add `GEMINI_EVAL_API_KEY=<key>` to the repo-root
   `.env`.

## The nightly eval

`.github/workflows/eval-nightly.yml` runs at 08:15 UTC (01:15 PDT, 00:15
PST), just after the eval project's quota resets at midnight Pacific, so it
gets fresh Flash quota before that day's PR evals, and on demand
(`gh workflow run eval-nightly.yml`). It calls Gemini for every case, with
no replay, so it catches model drift that a replay cannot. Case i (in run
order) starts on model (i + day) mod 3 of production's chain and falls
through the rest in order, so over three nights each case is answered by
each model. Its summary lists each case's answering model and the
`quotaValue` of every 429, which is how the daily limits get measured.

A failure opens one issue labelled `eval-nightly` with the summary table,
or comments on the open one. The next pass closes it. Its refreshed goldens
are the run's `goldens` artifact.

A case answered by a fallback model passes when its answer satisfies
`expect`: a real message sent that day would have been answered by the same
model (owner ruling 2026-10-28, DECISIONS.md). The job summary still lists
each case's answering model.

## The needs/wants accuracy check

`npm run eval:buckets` measures how often production's bucket call agrees
with the owner on the owner's own history. It runs on the owner's machine
only, never in CI, and nothing it reads or writes is tracked.

Ground truth is the expenses no ingestion was confirmed into: the Notion
import, where the owner picked every `Bucket` by hand. Bot-created rows are
left out. Their bucket is Gemini's, and the owner only pressed Confirm, so
counting them would score the model against itself.

For each sampled expense the script rebuilds a text message from the row
(description, amount, merchant, venue, lines, funder, tags, notes; never
the bucket) and sends it through `extractFromText`, the bot's text path,
with the live taxonomy and the private rules. Each owner line is paired with
an answer line of the same amount, else the same position. stdout shows
agreement, a truth→predicted confusion table per category, which model
answered each case, and every mismatch with its message.

What it reads, all from the main checkout and all gitignored:

| Input | Where |
|---|---|
| Rows | `finflow_readonly` through the pooler in `supabase/.temp/pooler-url` (password `FINFLOW_READONLY_PASSWORD` in `.env`), over TLS verified against Supabase's public root CA, `supabase/prod-ca-2021.crt` |
| Rules | `docs/BUCKET_RULES.local.md`, or `--rules PATH` |
| Key | `GEMINI_EVAL_API_KEY` from the environment, else from `.env` |

Run it from the repo root after a change to the bucket prompt, the rules, or
the model pins, and before trusting a rules edit:

```sh
npm --prefix lambda run eval:buckets                  # 10 cases, seed 1
npm --prefix lambda run eval:buckets -- --sample 20 --seed 2 --detail
npm --prefix lambda run eval:buckets -- --dry-run     # the messages, no Gemini call
```

One request per case, 13 s apart, on the eval key's daily quota (20 per
Flash model), so keep `--sample` at 20 or less. The same seed picks the
same cases while the history is unchanged. `--detail` writes every case as
JSON to `lambda/.eval-buckets/`. The unit tests in
`lambda/tests/eval-buckets.test.ts` cover sampling, the message, pairing and
the report on synthetic rows.

## Adding or changing a behaviour

In the same PR: add or change its row above, add a journey for it in
`lambda/tests/journeys/`, and add a golden case when Gemini's answer is part
of the behaviour. The `inventory` job fails the PR otherwise.
