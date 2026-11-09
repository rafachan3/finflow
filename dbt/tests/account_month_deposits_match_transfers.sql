-- Per month of the month list, fct_account_month.deposits summed across
-- accounts equals fct_monthly_summary.transfers (chequing to an account).
-- Returns months that disagree. The nightly checks production.
with deposited as (
    select month_start, sum(deposits) as deposits
    from {{ ref('fct_account_month') }}
    group by 1
)

select p.month_start
from {{ ref('fct_month_plan') }} as p
join {{ ref('fct_monthly_summary') }} as s using (month_start)
left join deposited as d using (month_start)
where coalesce(d.deposits, 0) is distinct from s.transfers
