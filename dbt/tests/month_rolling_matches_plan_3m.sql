-- fct_month_rolling's N = 3 share ratios equal fct_month_plan.*_pct_3m
-- every month (docs/SEMANTIC_LAYER.md, "Rolling N months"). Returns
-- months that disagree or that the rolling mart omits. The nightly
-- checks production.
select p.month_start, v.col
from {{ ref('fct_month_plan') }} as p
left join {{ ref('fct_month_rolling') }} as r
    on r.month_start = p.month_start and r.window_months = 3
cross join lateral (values
    ('needs_pct', p.needs_pct_3m, r.needs_pct),
    ('wants_pct', p.wants_pct_3m, r.wants_pct),
    ('financial_future_pct', p.financial_future_pct_3m, r.financial_future_pct),
    ('unallocated_pct', p.unallocated_pct_3m, r.unallocated_pct)
) as v (col, plan, rolling)
where r.month_start is null or v.plan is distinct from v.rolling
