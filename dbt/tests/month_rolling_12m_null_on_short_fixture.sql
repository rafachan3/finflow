-- A 12-month window is null across the 8-month fixture: every N = 12
-- row has null sums and ratios, and complete_months_in_window < 12.
-- Tagged fixture: production will one day have 12 complete months.
{{ config(tags=['fixture']) }}

select month_start
from {{ ref('fct_month_rolling') }}
where window_months = 12
  and (
      complete_months_in_window >= 12
      or spendable_income is not null
      or needs_spend is not null
      or wants_spend is not null
      or financial_future is not null
      or unallocated_cash is not null
      or spend is not null
      or income is not null
      or needs_pct is not null
      or wants_pct is not null
      or financial_future_pct is not null
      or unallocated_pct is not null
      or unspent_rate is not null
  )

union all

-- One N = 12 row per month of the fixture list (2026-03 to 2026-10).
select null
from {{ ref('fct_month_rolling') }}
where window_months = 12
having count(*) <> 8
    or min(month_start) is distinct from date '2026-03-01'
    or max(month_start) is distinct from date '2026-10-01'
