-- Every transaction is dated from the ledger start (var ledger_start, the
-- first day the ledger covers) to Toronto's tomorrow. A date outside that
-- is a misread or mistyped date, and the row silently misses its month, so
-- this fails the build. Supersedes the warn-only future check
-- (DECISIONS 2026-11-02). Returns ids only.
select transaction_id
from {{ ref('stg_transactions') }}
where occurred_on < '{{ var("ledger_start") }}'::date
   or occurred_on > {{ toronto_today() }} + 1
