-- fct_month_plan covers exactly the month list (fct_monthly_summary's
-- months from the ledger start's month on). Its baseline matches one
-- recomputed here from the month list by calendar month, not from the
-- mart's window. A complete month plans from the actual income: the
-- three plans are target_pct times spendable_income, financial_future_plan
-- equals financial_future_target, and income_received_share is 1 (null
-- with no income). An incomplete month expects the higher of income so far
-- and the baseline, and nothing with no baseline; its as_of_day is today's
-- day in the current month and 0 in a later one. Returns the months that
-- break it; the nightly checks production.
with list as (
    select *
    from {{ ref('fct_monthly_summary') }}
    where month_start >= date_trunc('month', '{{ var("ledger_start") }}'::date)
),

recomputed as (
    select
        l.*,
        b.baseline_months,
        b.baseline
    from list as l
    cross join lateral (
        select count(*) as baseline_months, round(avg(x.spendable_income), 2) as baseline
        from list as x
        where x.is_complete_month
          and x.month_start >= (l.month_start - interval '3 months')::date
          and x.month_start < l.month_start
    ) as b
),

expected as (
    select
        *,
        case
            when is_complete_month then spendable_income
            when baseline_months = 0 then null
            when spendable_income > baseline then spendable_income
            else baseline
        end as income_expected
    from recomputed
)

select coalesce(p.month_start, s.month_start) as month_start
from {{ ref('fct_month_plan') }} as p
full join expected as s on s.month_start = p.month_start
where p.month_start is null
   or s.month_start is null
   or p.is_complete_month is distinct from s.is_complete_month
   or p.spendable_income is distinct from s.spendable_income
   or p.baseline_months is distinct from s.baseline_months
   or p.spendable_income_baseline is distinct from s.baseline
   or p.spendable_income_expected is distinct from s.income_expected
   or p.needs_plan is distinct from round(s.needs_target_pct * s.income_expected, 2)
   or p.wants_plan is distinct from round(s.wants_target_pct * s.income_expected, 2)
   or p.financial_future_plan is distinct from round(s.financial_future_target_pct * s.income_expected, 2)
   or (p.is_complete_month and (
        p.financial_future_plan is distinct from s.financial_future_target
        or p.income_received_share is distinct from
            round(s.spendable_income / nullif(s.spendable_income, 0), 4)
        or p.as_of_day is distinct from p.days_in_month))
   or (not p.is_complete_month and p.as_of_day is distinct from (
        case
            when p.month_start = date_trunc('month', {{ toronto_today() }})::date
                then extract(day from {{ toronto_today() }})::integer
            else 0
        end))
