-- One row per (month_start, bucket, subcategory_id) for every month of
-- fct_month_plan and every (bucket, subcategory) pair with an own spend
-- line in some month of it, zero-filled (docs/SEMANTIC_LAYER.md, "Planning
-- marts"): a mean over only the months a subcategory appeared in would run
-- high. Own spend lines only, as in spend; summed over bucket, spend is
-- fct_category_month.spend. The rows frame counts months, because the grid
-- is zero-filled.
with months as (
    select month_start, is_complete_month
    from {{ ref('fct_month_plan') }}
),

own as (
    select f.month_start, f.bucket, f.subcategory_id, f.category_name, f.subcategory_name, f.amount
    from {{ ref('fct_transactions') }} as f
    join months as m on m.month_start = f.month_start
    where f.type = 'expense' and f.is_self_funded
),

pairs as (
    select distinct bucket, subcategory_id, category_name, subcategory_name
    from own
),

monthly as (
    select month_start, bucket, subcategory_id, sum(amount) as spend, count(*) as line_count
    from own
    group by month_start, bucket, subcategory_id
),

grid as (
    select
        m.month_start,
        m.is_complete_month,
        p.bucket,
        p.subcategory_id,
        p.category_name,
        p.subcategory_name,
        coalesce(s.spend, 0) as spend,
        coalesce(s.line_count, 0) as line_count
    from months as m
    cross join pairs as p
    left join monthly as s
        on s.month_start = m.month_start
       and s.bucket = p.bucket
       and s.subcategory_id = p.subcategory_id
),

baselines as (
    select
        *,
        count(*) filter (where is_complete_month) over baseline as baseline_months,
        avg(spend) filter (where is_complete_month) over baseline as spend_avg,
        avg(line_count) filter (where is_complete_month) over baseline as line_count_avg
    from grid
    window baseline as (
        partition by bucket, subcategory_id
        order by month_start
        rows between 3 preceding and 1 preceding
    )
)

select
    month_start,
    bucket,
    subcategory_id,
    category_name,
    subcategory_name,
    spend::numeric(12, 2) as spend,
    line_count::integer as line_count,
    baseline_months::integer as baseline_months,
    round(spend_avg, 2)::numeric(12, 2) as spend_avg_3m,
    round(line_count_avg, 4)::numeric(9, 4) as line_count_avg_3m,
    (spend - round(spend_avg, 2))::numeric(12, 2) as spend_delta,
    line_count + 3 * coalesce(line_count_avg, 0) < 6 as is_few_lines
from baselines
