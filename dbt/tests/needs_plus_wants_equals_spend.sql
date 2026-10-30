-- Every own spend line is needs or wants, so the two add up to spend, and
-- fixed plus variable needs add up to needs, exactly, every month
-- (docs/SEMANTIC_LAYER.md).
select month_start
from {{ ref('fct_monthly_summary') }}
where needs_spend + wants_spend <> spend
   or fixed_base_burn + variable_needs <> needs_spend
