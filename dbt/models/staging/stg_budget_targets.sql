-- The one budget_targets row (migration 0018) as fractions of spendable
-- income, so they compare directly with the *_pct shares
-- (docs/SEMANTIC_LAYER.md, "Targets"). Percentages with two decimals divided
-- by 100 are exact in numeric(9,4).
select
    (needs_percent / 100)::numeric(9, 4) as needs_target_pct,
    (wants_percent / 100)::numeric(9, 4) as wants_target_pct,
    (financial_future_percent / 100)::numeric(9, 4) as financial_future_target_pct
from {{ source('ledger', 'budget_targets') }}
