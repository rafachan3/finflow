-- stg_transactions takes entry_source from the earliest confirmed ingestion;
-- this warns if a transaction ever has two.
{{ config(severity='warn') }}
select transaction_id
from {{ source('ledger', 'ingestions') }}
where status = 'confirmed' and transaction_id is not null
group by transaction_id
having count(*) > 1
