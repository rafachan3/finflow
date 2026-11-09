-- Per month of the month list, fct_account_month.withdrawals summed
-- across accounts equals fct_monthly_summary.withdrawals (an account to
-- chequing). Returns months that disagree. The nightly checks production.
with withdrawn as (
    select month_start, sum(withdrawals) as withdrawals
    from {{ ref('fct_account_month') }}
    group by 1
)

select p.month_start
from {{ ref('fct_month_plan') }} as p
join {{ ref('fct_monthly_summary') }} as s using (month_start)
left join withdrawn as w using (month_start)
where coalesce(w.withdrawals, 0) is distinct from s.withdrawals
