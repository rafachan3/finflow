-- fct_category_month splits each month's spend, needs, wants and external
-- spend by subcategory and loses nothing: per month, its rows sum to
-- fct_monthly_summary. Returns months, never amounts.
with categories as (
    select
        month_start,
        sum(spend) as spend,
        sum(needs_spend) as needs_spend,
        sum(wants_spend) as wants_spend,
        sum(external_spend) as external_spend
    from {{ ref('fct_category_month') }}
    group by month_start
)

select s.month_start
from {{ ref('fct_monthly_summary') }} as s
left join categories as c on c.month_start = s.month_start
where coalesce(c.spend, 0) <> s.spend
   or coalesce(c.needs_spend, 0) <> s.needs_spend
   or coalesce(c.wants_spend, 0) <> s.wants_spend
   or coalesce(c.external_spend, 0) <> s.external_spend
