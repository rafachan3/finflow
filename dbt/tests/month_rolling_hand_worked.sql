-- fct_month_rolling on the fixture against values worked out by hand
-- from fixtures/synthetic.sql. Tagged `fixture`.
--
-- Monthly inputs (fixture_financial_future_expected and
-- fixture_sample_month_expected), spendable / needs / wants / financial
-- future / unallocated / spend / income:
--   03     0.00 /    0.00 /   0.00 / -80.00 /   80.00 /    0.00 /    0.00
--   04     0.00 /    0.00 /   0.00 /  80.00 /  -80.00 /    0.00 /    0.00
--   05  1000.00 /  600.00 / 400.00 /   0.00 /    0.00 / 1000.00 / 1002.50
--   06  3025.00 / 1237.75 /  38.14 / 650.00 / 1099.11 / 1275.89 / 3029.12
--   10 nothing: the current month, incomplete
--
-- 2026-06, N = 3, rolling 04-06 (all complete):
--   spendable 4025.00; needs 1837.75 -> 0.4566; wants 438.14 -> 0.1089;
--   financial future 730.00 -> 0.1814; unallocated 1019.11 -> 0.2532;
--   spend 2275.89; income 4031.62;
--   unspent_rate (4031.62 - 2275.89) / 4031.62 = 0.435489... = 0.4355.
-- 2026-03, N = 3: only one month in the list, so sums are null.
-- 2026-10, N = 3: October is incomplete, so sums are null (2 of 3).
{{ config(tags=['fixture']) }}

with expected (month_start, window_months, col, value) as (
    values
        (date '2026-06-01', 3, 'complete_months_in_window', 3),
        (date '2026-06-01', 3, 'spendable_income', 4025.00),
        (date '2026-06-01', 3, 'needs_spend', 1837.75),
        (date '2026-06-01', 3, 'wants_spend', 438.14),
        (date '2026-06-01', 3, 'financial_future', 730.00),
        (date '2026-06-01', 3, 'unallocated_cash', 1019.11),
        (date '2026-06-01', 3, 'spend', 2275.89),
        (date '2026-06-01', 3, 'income', 4031.62),
        (date '2026-06-01', 3, 'needs_pct', 0.4566),
        (date '2026-06-01', 3, 'wants_pct', 0.1089),
        (date '2026-06-01', 3, 'financial_future_pct', 0.1814),
        (date '2026-06-01', 3, 'unallocated_pct', 0.2532),
        (date '2026-06-01', 3, 'unspent_rate', 0.4355),

        (date '2026-03-01', 3, 'complete_months_in_window', 1),
        (date '2026-03-01', 3, 'spendable_income', null),
        (date '2026-03-01', 3, 'needs_pct', null),
        (date '2026-03-01', 3, 'unspent_rate', null),

        (date '2026-10-01', 3, 'complete_months_in_window', 2),
        (date '2026-10-01', 3, 'spendable_income', null),
        (date '2026-10-01', 3, 'needs_pct', null),
        (date '2026-10-01', 3, 'unspent_rate', null),

        (date '2026-10-01', 12, 'complete_months_in_window', 7),
        (date '2026-10-01', 12, 'spendable_income', null),
        (date '2026-10-01', 12, 'unspent_rate', null)
),

actual (month_start, window_months, col, value) as (
    select r.month_start, r.window_months, v.col, v.value
    from {{ ref('fct_month_rolling') }} as r
    cross join lateral (values
        ('complete_months_in_window', r.complete_months_in_window::numeric),
        ('spendable_income', r.spendable_income),
        ('needs_spend', r.needs_spend),
        ('wants_spend', r.wants_spend),
        ('financial_future', r.financial_future),
        ('unallocated_cash', r.unallocated_cash),
        ('spend', r.spend),
        ('income', r.income),
        ('needs_pct', r.needs_pct),
        ('wants_pct', r.wants_pct),
        ('financial_future_pct', r.financial_future_pct),
        ('unallocated_pct', r.unallocated_pct),
        ('unspent_rate', r.unspent_rate)
    ) as v (col, value)
)

select e.month_start, e.window_months, e.col, e.value as expected, a.value as actual
from expected as e
left join actual as a
    on a.month_start = e.month_start
   and a.window_months = e.window_months
   and a.col = e.col
where a.month_start is null or e.value is distinct from a.value

union all

-- The month list is 2026-03 to 2026-10, two window lengths.
select null, null, 'rows', 16, count(*)
from {{ ref('fct_month_rolling') }}
having count(*) <> 16
    or min(month_start) is distinct from date '2026-03-01'
    or max(month_start) is distinct from date '2026-10-01'
