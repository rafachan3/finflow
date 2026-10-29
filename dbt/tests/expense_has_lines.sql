-- Every expense has at least one line (DATA_MODEL invariant).
select t.transaction_id
from {{ ref('stg_transactions') }} as t
where t.type = 'expense'
  and not exists (
      select 1 from {{ ref('stg_transaction_items') }} as i
      where i.transaction_id = t.transaction_id
  )
