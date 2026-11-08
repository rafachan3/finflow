-- fct_ledger_entry has exactly one row per stg_transactions row: no
-- missing, extra, duplicate or null transaction_id. Returns ids, never
-- amounts. The nightly checks production.
select t.transaction_id::text as id
from {{ ref('stg_transactions') }} as t
left join {{ ref('fct_ledger_entry') }} as e using (transaction_id)
where e.transaction_id is null

union all

select e.transaction_id::text
from {{ ref('fct_ledger_entry') }} as e
left join {{ ref('stg_transactions') }} as t using (transaction_id)
where t.transaction_id is null

union all

select transaction_id::text
from {{ ref('fct_ledger_entry') }}
group by 1
having count(*) <> 1
