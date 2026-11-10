-- One row per (month_start, bucket, subcategory_id) for every month of
-- fct_month_plan and every (bucket, subcategory) pair with an own spend
-- line in some month of it, zero-filled (docs/SEMANTIC_LAYER.md, "Planning
-- marts"): a mean over only the months a subcategory appeared in would run
-- high. Own spend lines only, as in spend; summed over bucket, spend is
-- fct_category_month.spend. The rows frame counts months, because the grid
-- is zero-filled. spend_to_date_avg_3m is the baseline months' spend through
-- fct_pace_day's matching day of this month's as_of_day, so a month in
-- progress is compared like for like.
with months as (
    select month_start, is_complete_month, as_of_day, days_in_month
    from {{ ref('fct_month_plan') }}
),

own as (
    select
        f.month_start,
        f.bucket,
        f.subcategory_id,
        f.category_name,
        f.subcategory_name,
        f.amount,
        extract(day from f.occurred_on)::integer as day_of_month
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
),

-- The baseline months' own spend through the matching day, summed. A
-- (month, pair) with no such line has no row here and reads 0 below.
to_date as (
    select m.month_start, o.bucket, o.subcategory_id, sum(o.amount) as spend
    from months as m
    join months as b
        on b.is_complete_month
       and b.month_start between (m.month_start - interval '3 months')::date
                             and (m.month_start - interval '1 month')::date
    join own as o
        on o.month_start = b.month_start
       and o.day_of_month <= case
            when m.as_of_day = m.days_in_month then b.days_in_month
            else least(m.as_of_day, b.days_in_month)
        end
    group by m.month_start, o.bucket, o.subcategory_id
)

select
    b.month_start,
    b.bucket,
    b.subcategory_id,
    category_name,
    subcategory_name,
    b.spend::numeric(12, 2) as spend,
    line_count::integer as line_count,
    baseline_months::integer as baseline_months,
    round(spend_avg, 2)::numeric(12, 2) as spend_avg_3m,
    case when baseline_months > 0
        then round(coalesce(t.spend, 0) / baseline_months, 2)
    end::numeric(12, 2) as spend_to_date_avg_3m,
    round(line_count_avg, 4)::numeric(9, 4) as line_count_avg_3m,
    (b.spend - round(spend_avg, 2))::numeric(12, 2) as spend_delta,
    line_count + 3 * coalesce(line_count_avg, 0) < 6 as is_few_lines
from baselines as b
left join to_date as t
    on t.month_start = b.month_start
   and t.bucket = b.bucket
   and t.subcategory_id = b.subcategory_id
