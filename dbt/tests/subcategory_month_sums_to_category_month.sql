-- Over the month list, fct_subcategory_month summed over bucket equals
-- fct_category_month.spend for every (month, subcategory) with expense
-- lines, and is 0 for every zero-filled one without. Returns the
-- (month, subcategory) pairs that differ; the nightly checks production.
with sub as (
    select month_start, subcategory_id, sum(spend) as spend
    from {{ ref('fct_subcategory_month') }}
    group by month_start, subcategory_id
),

cat as (
    select c.month_start, c.subcategory_id, c.spend
    from {{ ref('fct_category_month') }} as c
    join {{ ref('fct_month_plan') }} as p on p.month_start = c.month_start
)

select
    coalesce(s.month_start, c.month_start) as month_start,
    coalesce(s.subcategory_id, c.subcategory_id) as subcategory_id
from sub as s
full join cat as c on c.month_start = s.month_start and c.subcategory_id = s.subcategory_id
where coalesce(s.spend, 0) <> coalesce(c.spend, 0)
