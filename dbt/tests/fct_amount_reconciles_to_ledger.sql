-- fct_transactions drops or doubles no ledger line: per type, its amounts
-- sum to the ledger's, read straight from public (expense lines, and
-- income and transfer headers). Whether lines match their header is
-- expense_lines_sum_to_header's job. Returns types, never amounts.
with ledger as (
    select 'expense' as type, sum(i.amount) as amount
    from {{ source('ledger', 'transaction_items') }} as i
    join {{ source('ledger', 'transactions') }} as t on t.id = i.transaction_id
    where t.type = 'expense'

    union all

    select type::text, sum(amount)
    from {{ source('ledger', 'transactions') }}
    where type <> 'expense'
    group by 1
),

fct as (
    select type, sum(amount) as amount
    from {{ ref('fct_transactions') }}
    group by 1
)

select coalesce(l.type, f.type) as type
from ledger as l
full join fct as f on f.type = l.type
where l.amount is distinct from f.amount
