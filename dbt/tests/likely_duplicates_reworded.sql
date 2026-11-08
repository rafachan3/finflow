-- One payment logged twice under two descriptions (issue #114): two
-- transactions of the same type and amount, at most 1 day apart, whose
-- descriptions differ once case and whitespace are ignored, as when one
-- receipt is titled by its merchant once and by its items the next time.
-- Kept apart from no_likely_duplicates, so two real purchases at one price
-- stay distinguishable from a pair whose descriptions match. Left out, to
-- keep it quiet: pairs under 3.00 where either row was imported (no
-- ingestion: the history's fares and laundry machines), pairs in one
-- recurring series, and pairs the owner acknowledged in
-- duplicate_acknowledgements. Warn only; the nightly reports the pairs.
-- Returns the two ids only, never a description or an amount.
{{ config(severity='warn') }}
with t as (
    select transaction_id, type, amount, occurred_on, entry_source, recurring_series_id,
           lower(regexp_replace(description, '\s+', '', 'g')) as description_key
    from {{ ref('stg_transactions') }}
)

select a.transaction_id, b.transaction_id as duplicate_of
from t as a
join t as b
    on b.type = a.type
   and b.amount = a.amount
   and b.description_key <> a.description_key
   and abs(b.occurred_on - a.occurred_on) <= 1
   and b.transaction_id < a.transaction_id
where not (a.amount < 3.00 and 'import' in (a.entry_source, b.entry_source))
  and not coalesce(a.recurring_series_id = b.recurring_series_id, false)
  and not exists (
    select from {{ source('ledger', 'duplicate_acknowledgements') }} as k
    where k.first_id = b.transaction_id and k.second_id = a.transaction_id
  )
