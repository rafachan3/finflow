-- Income and transfers have no lines (DATA_MODEL invariant).
select distinct i.transaction_id
from {{ ref('stg_transaction_items') }} as i
join {{ ref('stg_transactions') }} as t using (transaction_id)
where t.type <> 'expense'
