-- fct_month_plan on the fixture against values worked out by hand from
-- fixtures/synthetic.sql, with the seeded 50/30/20 targets, the fixture's
-- ledger start 2026-03-01 and today pinned to 2026-10-15. Tagged `fixture`.
--
-- Monthly inputs (fixture_financial_future_expected), as spendable income
-- / needs / wants / financial future / unallocated cash:
--   03    0.00 /    0.00 /   0.00 / -80.00 /   80.00
--   04    0.00 /    0.00 /   0.00 /  80.00 /  -80.00
--   05 1000.00 /  600.00 / 400.00 /   0.00 /    0.00
--   06 3025.00 / 1237.75 /  38.14 / 650.00 / 1099.11
--   07    0.00 /    3.75 /   0.00 /   0.00 /   -3.75
--   08 3000.00 / 1400.00 / 700.00 / 500.00 /  400.00
--   09 2000.00 /  310.00 /   0.00 / 150.00 / 1540.00
--   10 nothing: the current month, day 15 of 31
--
-- 2026-03, the first month of the list: baseline_months 0, so no baseline;
-- complete, so it expects its actual 0.00 and plans 0.00; no income, so no
-- income_received_share; no rolling shares (not 3 months in the list).
-- 2026-04: baseline_months 1 (March), baseline 0.00, still no rolling shares.
-- 2026-05, rolling 03-05: spendable 1000.00; needs 600.00 -> 0.6000, wants
--   400.00 -> 0.4000, financial future 0.00 -> 0.0000, unallocated
--   80.00 - 80.00 + 0 = 0.00 -> 0.0000.
-- 2026-06: baseline (0 + 0 + 1000.00) / 3 = 333.333... -> 333.33; expects
--   3025.00, share 1.0000; plans 1512.50 / 907.50 / 605.00.
--   Rolling 04-06, spendable 4025.00: needs 1837.75 -> 0.456583... = 0.4566,
--   wants 438.14 -> 0.108854... = 0.1089, financial future 730.00 ->
--   0.181366... = 0.1814, unallocated 1019.11 -> 0.253195... = 0.2532.
-- 2026-07, no income: baseline (0 + 1000.00 + 3025.00) / 3 = 1341.666...
--   -> 1341.67, but complete, so it expects 0.00; share null.
--   Rolling 05-07, spendable 4025.00: needs 1841.50 -> 0.457515... = 0.4575,
--   wants 438.14 -> 0.1089, financial future 650.00 -> 0.161490... =
--   0.1615, unallocated 1095.36 -> 0.272139... = 0.2721.
-- 2026-09: baseline (3025.00 + 0 + 3000.00) / 3 = 2008.333... -> 2008.33,
--   above its 2000.00, but complete, so it expects 2000.00; share 1.0000;
--   plans 1000.00 / 600.00 / 400.00; as_of_day 30.
--   Rolling 07-09, spendable 5000.00: needs 1713.75 -> 0.34275 = 0.3428,
--   wants 700.00 -> 0.1400, financial future 650.00 -> 0.1300,
--   unallocated 1936.25 -> 0.38725 = 0.3873.
-- 2026-10, current: as_of_day 15 of 31; baseline (0 + 3000.00 + 2000.00)
--   / 3 = 1666.666... -> 1666.67; income so far 0.00, so it expects
--   greatest(0.00, 1666.67) = 1666.67; share 0.0000; plans
--   0.5 * 1666.67 = 833.335 -> 833.34, 0.3 * 1666.67 = 500.001 -> 500.00,
--   0.2 * 1666.67 = 333.334 -> 333.33; no rolling shares (incomplete).
{{ config(tags=['fixture']) }}

with expected (month_start, col, value) as (
    values
        (date '2026-03-01', 'baseline_months', 0),
        (date '2026-03-01', 'spendable_income_baseline', null),
        (date '2026-03-01', 'spendable_income_expected', 0.00),
        (date '2026-03-01', 'income_received_share', null),
        (date '2026-03-01', 'needs_plan', 0.00),
        (date '2026-03-01', 'as_of_day', 31),
        (date '2026-03-01', 'needs_pct_3m', null),

        (date '2026-04-01', 'baseline_months', 1),
        (date '2026-04-01', 'spendable_income_baseline', 0.00),
        (date '2026-04-01', 'needs_pct_3m', null),

        (date '2026-05-01', 'baseline_months', 2),
        (date '2026-05-01', 'needs_pct_3m', 0.6000),
        (date '2026-05-01', 'wants_pct_3m', 0.4000),
        (date '2026-05-01', 'financial_future_pct_3m', 0.0000),
        (date '2026-05-01', 'unallocated_pct_3m', 0.0000),

        (date '2026-06-01', 'baseline_months', 3),
        (date '2026-06-01', 'spendable_income_baseline', 333.33),
        (date '2026-06-01', 'spendable_income_expected', 3025.00),
        (date '2026-06-01', 'income_received_share', 1.0000),
        (date '2026-06-01', 'needs_plan', 1512.50),
        (date '2026-06-01', 'wants_plan', 907.50),
        (date '2026-06-01', 'financial_future_plan', 605.00),
        (date '2026-06-01', 'needs_pct_3m', 0.4566),
        (date '2026-06-01', 'wants_pct_3m', 0.1089),
        (date '2026-06-01', 'financial_future_pct_3m', 0.1814),
        (date '2026-06-01', 'unallocated_pct_3m', 0.2532),

        (date '2026-07-01', 'spendable_income_baseline', 1341.67),
        (date '2026-07-01', 'spendable_income_expected', 0.00),
        (date '2026-07-01', 'income_received_share', null),
        (date '2026-07-01', 'needs_pct_3m', 0.4575),
        (date '2026-07-01', 'wants_pct_3m', 0.1089),
        (date '2026-07-01', 'financial_future_pct_3m', 0.1615),
        (date '2026-07-01', 'unallocated_pct_3m', 0.2721),

        (date '2026-09-01', 'is_complete_month', 1),
        (date '2026-09-01', 'baseline_months', 3),
        (date '2026-09-01', 'spendable_income_baseline', 2008.33),
        (date '2026-09-01', 'spendable_income_expected', 2000.00),
        (date '2026-09-01', 'income_received_share', 1.0000),
        (date '2026-09-01', 'needs_plan', 1000.00),
        (date '2026-09-01', 'wants_plan', 600.00),
        (date '2026-09-01', 'financial_future_plan', 400.00),
        (date '2026-09-01', 'as_of_day', 30),
        (date '2026-09-01', 'needs_pct_3m', 0.3428),
        (date '2026-09-01', 'wants_pct_3m', 0.1400),
        (date '2026-09-01', 'financial_future_pct_3m', 0.1300),
        (date '2026-09-01', 'unallocated_pct_3m', 0.3873),

        (date '2026-10-01', 'is_complete_month', 0),
        (date '2026-10-01', 'days_in_month', 31),
        (date '2026-10-01', 'as_of_day', 15),
        (date '2026-10-01', 'spendable_income', 0.00),
        (date '2026-10-01', 'baseline_months', 3),
        (date '2026-10-01', 'spendable_income_baseline', 1666.67),
        (date '2026-10-01', 'spendable_income_expected', 1666.67),
        (date '2026-10-01', 'income_received_share', 0.0000),
        (date '2026-10-01', 'needs_plan', 833.34),
        (date '2026-10-01', 'wants_plan', 500.00),
        (date '2026-10-01', 'financial_future_plan', 333.33),
        (date '2026-10-01', 'needs_pct_3m', null),
        (date '2026-10-01', 'wants_pct_3m', null),
        (date '2026-10-01', 'financial_future_pct_3m', null),
        (date '2026-10-01', 'unallocated_pct_3m', null)
),

actual (month_start, col, value) as (
    select p.month_start, v.col, v.value
    from {{ ref('fct_month_plan') }} as p
    cross join lateral (values
        ('is_complete_month', p.is_complete_month::integer::numeric),
        ('days_in_month', p.days_in_month::numeric),
        ('as_of_day', p.as_of_day::numeric),
        ('spendable_income', p.spendable_income),
        ('baseline_months', p.baseline_months::numeric),
        ('spendable_income_baseline', p.spendable_income_baseline),
        ('spendable_income_expected', p.spendable_income_expected),
        ('income_received_share', p.income_received_share),
        ('needs_plan', p.needs_plan),
        ('wants_plan', p.wants_plan),
        ('financial_future_plan', p.financial_future_plan),
        ('needs_pct_3m', p.needs_pct_3m),
        ('wants_pct_3m', p.wants_pct_3m),
        ('financial_future_pct_3m', p.financial_future_pct_3m),
        ('unallocated_pct_3m', p.unallocated_pct_3m)
    ) as v (col, value)
)

select e.month_start, e.col, e.value as expected, a.value as actual
from expected as e
left join actual as a on a.month_start = e.month_start and a.col = e.col
where a.month_start is null or e.value is distinct from a.value

union all

-- The month list is 2026-03 to 2026-10.
select null, 'months', 8, count(*)
from {{ ref('fct_month_plan') }}
having count(*) <> 8 or min(month_start) <> date '2026-03-01'
    or max(month_start) <> date '2026-10-01'
