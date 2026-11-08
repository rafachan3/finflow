-- Likely double entries: two transactions of the same type and amount,
-- dated at most 3 days apart, whose descriptions match once case and
-- whitespace are ignored (a typed row and an imported or series row of the
-- same payment). Rows whose descriptions differ are never listed: two
-- tickets or two appliances at the same price are real. Warn only, because
-- the ledger can hold a genuine repeat; the nightly reports the pairs. A
-- pair the owner acknowledged in duplicate_acknowledgements is left out.
-- Returns the two ids only, never a description or an amount.
{{ config(severity='warn') }}
with t as (
    select transaction_id, type, amount, occurred_on,
           lower(regexp_replace(description, '\s+', '', 'g')) as description_key
    from {{ ref('stg_transactions') }}
)

select a.transaction_id, b.transaction_id as duplicate_of
from t as a
join t as b
    on b.type = a.type
   and b.amount = a.amount
   and b.description_key = a.description_key
   and abs(b.occurred_on - a.occurred_on) <= 3
   and b.transaction_id < a.transaction_id
where not exists (
    select from {{ source('ledger', 'duplicate_acknowledgements') }} as k
    where k.first_id = b.transaction_id and k.second_id = a.transaction_id
)
