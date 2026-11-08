-- One row per (date_day, series) for every day of every month of
-- fct_month_plan (docs/SEMANTIC_LAYER.md, "Planning marts"). Each series
-- sums its metric's own filter by occurred_on, zero-filled; days after
-- Toronto's today have no amount but keep the usual curve, which averages
-- the baseline months' month-to-date at the matching day: the same day of
-- month, capped at the baseline month's length, and its last day for the
-- last day of this month.
with plan as (
    select month_start, is_complete_month, days_in_month
    from {{ ref('fct_month_plan') }}
),

by_day as (
    select
        occurred_on as date_day,
        sum(amount) filter (
            where type = 'expense' and is_self_funded and bucket = 'needs') as needs,
        sum(amount) filter (
            where type = 'expense' and is_self_funded and bucket = 'wants') as wants,
        sum(amount) filter (
            where type = 'expense' and is_self_funded and bucket = 'needs'
              and not is_recurring) as variable_needs,
        coalesce(sum(amount) filter (
            where type = 'transfer' and from_account_name is null
              and to_account_name is not null), 0)
        - coalesce(sum(amount) filter (
            where type = 'transfer' and from_account_name is not null
              and to_account_name is null), 0) as financial_future,
        sum(amount) filter (
            where type = 'income' and deposit_account_name is null) as spendable_income
    from {{ ref('fct_transactions') }}
    group by occurred_on
),

grid as (
    select
        d.date_day,
        p.month_start,
        extract(day from d.date_day)::integer as day_of_month,
        p.days_in_month,
        p.is_complete_month,
        s.series,
        d.date_day > {{ toronto_today() }} as is_after_today,
        coalesce(s.amount, 0) as amount
    from {{ ref('dim_date') }} as d
    join plan as p on p.month_start = d.month_start
    left join by_day as b on b.date_day = d.date_day
    cross join lateral (values
        ('needs', b.needs),
        ('wants', b.wants),
        ('variable_needs', b.variable_needs),
        ('financial_future', b.financial_future),
        ('spendable_income', b.spendable_income)
    ) as s (series, amount)
),

running as (
    select
        *,
        sum(amount) over (partition by series, month_start order by date_day) as mtd,
        sum(amount) over (partition by series, month_start) as total
    from grid
),

pace as (
    select
        m.date_day,
        m.series,
        avg(b.mtd) as pace_mtd,
        avg(b.mtd / nullif(b.total, 0)) as pace_share
    from running as m
    join running as b
        on b.series = m.series
       and b.is_complete_month
       and b.month_start between (m.month_start - interval '3 months')::date
                             and (m.month_start - interval '1 month')::date
       and b.day_of_month = case
            when m.day_of_month = m.days_in_month then b.days_in_month
            else least(m.day_of_month, b.days_in_month)
        end
    group by m.date_day, m.series
)

select
    r.date_day,
    r.month_start,
    r.day_of_month,
    r.series,
    case when not r.is_after_today then r.amount end::numeric(12, 2) as amount_day,
    case when not r.is_after_today then r.mtd end::numeric(12, 2) as amount_mtd,
    case when r.is_complete_month then r.total end::numeric(12, 2) as month_total,
    round(p.pace_mtd, 2)::numeric(12, 2) as pace_mtd_avg_3m,
    round(p.pace_share, 4)::numeric(9, 4) as pace_share_avg_3m
from running as r
left join pace as p on p.date_day = r.date_day and p.series = r.series
