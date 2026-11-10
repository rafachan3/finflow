-- fct_subcategory_month.spend_to_date_avg_3m against fct_pace_day, which
-- works out the same baseline independently: summed over a bucket's
-- subcategories it is that bucket's pace_mtd_avg_3m on the month's
-- as_of_day, within half a cent per rounded mean. In a complete month it
-- is spend_avg_3m. Returns the months and rows that differ; the nightly
-- checks production, where baseline lines fall on both sides of the day.
with by_bucket as (
    select month_start, bucket, sum(spend_to_date_avg_3m) as to_date, count(*) as pairs
    from {{ ref('fct_subcategory_month') }}
    where baseline_months > 0
    group by month_start, bucket
)

select b.month_start, b.bucket, null::smallint as subcategory_id, b.to_date as actual, d.pace_mtd_avg_3m as expected
from by_bucket as b
join {{ ref('fct_month_plan') }} as p on p.month_start = b.month_start
join {{ ref('fct_pace_day') }} as d
    on d.series = b.bucket
   and d.date_day = p.month_start + (p.as_of_day - 1)
where p.as_of_day > 0
  and abs(b.to_date - d.pace_mtd_avg_3m) > 0.005 * (b.pairs + 1)

union all

select s.month_start, s.bucket, s.subcategory_id, s.spend_to_date_avg_3m, s.spend_avg_3m
from {{ ref('fct_subcategory_month') }} as s
join {{ ref('fct_month_plan') }} as p on p.month_start = s.month_start
where p.is_complete_month
  and s.spend_to_date_avg_3m is distinct from s.spend_avg_3m
