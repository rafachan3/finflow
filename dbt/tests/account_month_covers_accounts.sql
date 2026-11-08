-- One row per (month of the month list, account). Returns a month and
-- account the mart omits or an extra it should not have. The nightly
-- checks production.
select p.month_start::text as month_start, a.name as account_name
from {{ ref('fct_month_plan') }} as p
cross join {{ source('ledger', 'accounts') }} as a
left join {{ ref('fct_account_month') }} as m
    on m.month_start = p.month_start and m.account_name = a.name
where m.month_start is null

union all

select m.month_start::text, m.account_name
from {{ ref('fct_account_month') }} as m
left join {{ ref('fct_month_plan') }} as p using (month_start)
left join {{ source('ledger', 'accounts') }} as a on a.name = m.account_name
where p.month_start is null or a.id is null
