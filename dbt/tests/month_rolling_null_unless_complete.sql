-- Money sums on fct_month_rolling are null unless every month of the
-- window is complete and in the list; the four *_pct shares and
-- unspent_rate are also null when their denominator sums to 0. Returns
-- rows that break it. The nightly checks production.
select month_start, window_months
from {{ ref('fct_month_rolling') }}
where complete_months_in_window < 0
   or complete_months_in_window > window_months
   or (complete_months_in_window = window_months)
        is distinct from (spendable_income is not null)
   or (spendable_income is null) is distinct from (needs_spend is null)
   or (spendable_income is null) is distinct from (wants_spend is null)
   or (spendable_income is null) is distinct from (financial_future is null)
   or (spendable_income is null) is distinct from (unallocated_cash is null)
   or (spendable_income is null) is distinct from (spend is null)
   or (spendable_income is null) is distinct from (income is null)
   or (needs_pct is not null) is distinct from (
        complete_months_in_window = window_months and spendable_income <> 0)
   or (wants_pct is not null) is distinct from (
        complete_months_in_window = window_months and spendable_income <> 0)
   or (financial_future_pct is not null) is distinct from (
        complete_months_in_window = window_months and spendable_income <> 0)
   or (unallocated_pct is not null) is distinct from (
        complete_months_in_window = window_months and spendable_income <> 0)
   or (unspent_rate is not null) is distinct from (
        complete_months_in_window = window_months and income <> 0)
