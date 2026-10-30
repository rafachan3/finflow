-- One row per day, from the first day of the first data month to a year
-- past Toronto's today: the zero-fill for fct_monthly_summary, Grafana's
-- empty days, and MetricFlow's time spine. With no data yet it starts at
-- the current month.
select
    d::date as date_day,
    date_trunc('month', d)::date as month_start
from generate_series(
    (select date_trunc('month', coalesce(min(occurred_on), {{ toronto_today() }}))
     from {{ ref('stg_transactions') }}),
    {{ toronto_today() }} + 365,
    interval '1 day'
) as d
