-- One row per (month_start, subcategory_id) that has expense lines. Spend
-- columns use the contract's own-spend-line rule; external_spend is the
-- rest, and line_count counts both.
select
    month_start,
    subcategory_id,
    category_name,
    subcategory_name,
    coalesce(sum(amount) filter (where is_self_funded), 0)::numeric(12, 2) as spend,
    coalesce(sum(amount) filter (where is_self_funded and bucket = 'needs'), 0)::numeric(12, 2)
        as needs_spend,
    coalesce(sum(amount) filter (where is_self_funded and bucket = 'wants'), 0)::numeric(12, 2)
        as wants_spend,
    coalesce(sum(amount) filter (where not is_self_funded), 0)::numeric(12, 2) as external_spend,
    count(*)::integer as line_count
from {{ ref('fct_transactions') }}
where type = 'expense'
group by month_start, subcategory_id, category_name, subcategory_name
