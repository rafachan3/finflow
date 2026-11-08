-- fct_month_plan covers exactly the month list (fct_monthly_summary's
-- months from the ledger start's month on), and in a complete month it
-- plans from the actual income: the three plans are target_pct times
-- spendable_income, financial_future_plan equals financial_future_target,
-- and income_received_share is 1 (null with no income). Returns the months
-- that break it; the nightly checks production.
with list as (
    select *
    from {{ ref('fct_monthly_summary') }}
    where month_start >= date_trunc('month', '{{ var("ledger_start") }}'::date)
)

select coalesce(p.month_start, s.month_start) as month_start
from {{ ref('fct_month_plan') }} as p
full join list as s on s.month_start = p.month_start
where p.month_start is null
   or s.month_start is null
   or p.is_complete_month is distinct from s.is_complete_month
   or p.spendable_income is distinct from s.spendable_income
   or (p.is_complete_month and (
        p.spendable_income_expected is distinct from s.spendable_income
        or p.needs_plan is distinct from round(s.needs_target_pct * s.spendable_income, 2)
        or p.wants_plan is distinct from round(s.wants_target_pct * s.spendable_income, 2)
        or p.financial_future_plan is distinct from s.financial_future_target
        or p.income_received_share is distinct from
            round(s.spendable_income / nullif(s.spendable_income, 0), 4)
        or p.as_of_day is distinct from p.days_in_month))
