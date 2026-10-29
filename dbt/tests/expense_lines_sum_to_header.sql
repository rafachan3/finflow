-- Every expense's lines sum exactly to its amount (DATA_MODEL invariant).
-- numeric(12,2) compares exactly, to the cent. An expense with no lines is
-- expense_has_lines's to report.
select t.transaction_id
from {{ ref('stg_transactions') }} as t
join {{ ref('stg_transaction_items') }} as i using (transaction_id)
where t.type = 'expense'
group by t.transaction_id, t.amount
having sum(i.amount) <> t.amount
