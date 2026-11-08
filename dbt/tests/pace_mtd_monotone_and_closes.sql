-- fct_pace_day's month-to-date never falls for a series of positive
-- amounts (every series but financial_future, which a withdrawal lowers),
-- and on the last day of a complete month every series closes at that
-- month's metric in fct_monthly_summary and at its own month_total.
-- Returns the days and series that break it; the nightly checks
-- production.
with steps as (
    select
        date_day,
        series,
        amount_mtd,
        lag(amount_mtd) over (partition by series, month_start order by date_day) as previous
    from {{ ref('fct_pace_day') }}
),

last_days as (
    select s.month_start, v.series, v.metric
    from {{ ref('fct_monthly_summary') }} as s
    join {{ ref('fct_month_plan') }} as p on p.month_start = s.month_start
    cross join lateral (values
        ('needs', s.needs_spend),
        ('wants', s.wants_spend),
        ('variable_needs', s.variable_needs),
        ('financial_future', s.financial_future),
        ('spendable_income', s.spendable_income)
    ) as v (series, metric)
    where p.is_complete_month
)

select date_day, series, 'falls' as problem
from steps
where series <> 'financial_future' and amount_mtd < previous

union all

select l.month_start, l.series, 'does not close'
from last_days as l
left join {{ ref('fct_pace_day') }} as d
    on d.series = l.series
   and d.date_day = (l.month_start + interval '1 month' - interval '1 day')::date
where d.amount_mtd is distinct from l.metric
   or d.month_total is distinct from l.metric
