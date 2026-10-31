-- The 50/30/20 identity, every month (docs/SEMANTIC_LAYER.md): spendable
-- income is exactly spend plus financial future plus what is still in
-- chequing, in dollars. The four shares sum to 1 within 0.0005 (each is
-- rounded to 4 places) when spendable_income > 0, and all four are null
-- when it is 0. Returns months only, never values: the nightly log is public.
select month_start
from {{ ref('fct_monthly_summary') }}
where spendable_income <> spend + financial_future + unallocated_cash
   or (spendable_income > 0
       and abs(needs_pct + wants_pct + financial_future_pct + unallocated_pct - 1) > 0.0005)
   or (spendable_income > 0
       and (needs_pct is null or wants_pct is null
            or financial_future_pct is null or unallocated_pct is null))
   or (spendable_income = 0
       and (needs_pct is not null or wants_pct is not null
            or financial_future_pct is not null or unallocated_pct is not null))
