-- A transaction flagged recurring is linked to a recurring series. Since
-- migration 0016 linking sets the flag, but a row inserted unlinked keeps
-- the flag it was given, and the ledger holds one
-- such leftover that is not yet linked or cleared. So this warns rather
-- than fails: the nightly lists the ids until each is linked to its series
-- or has its flag cleared. Returns ids only.
{{ config(severity='warn') }}
select id as transaction_id
from {{ source('ledger', 'transactions') }}
where is_recurring and recurring_series_id is null
