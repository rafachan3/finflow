-- fct_pace_day on the fixture against values worked out by hand from
-- fixtures/synthetic.sql, with today pinned to 2026-10-15. Tagged
-- `fixture`. Each day's usual values average the baseline months'
-- month-to-date at the matching day; a baseline month whose series totals
-- 0 is left out of the share.
--
-- 2026-09-30 financial_future, the last day of a 30-day month: it matches
--   June 30, July 31 and August 31. Month-to-date there: June 500.00 +
--   300.00 - 150.00 = 650.00, July 0, August 300.00 + 200.00 (both on the
--   31st) = 500.00. Usual 1150.00 / 3 = 383.333... -> 383.33; share (1 +
--   1) / 2 = 1.0000 (July totals 0). September itself: the 150.00 extra
--   loan payment on the 30th (the 100.00 from savings is in no metric).
-- 2026-09-29 financial_future: June 29 650.00, July 0, August 29 0. Usual
--   650.00 / 3 = 216.666... -> 216.67; share (1 + 0) / 2 = 0.5000.
-- 2026-10-15 wants, today: August's 700.00 is on the 15th, July and
--   September have none. Usual 700.00 / 3 = 233.33, share 1.0000 (only
--   August has wants). October has no rows: 0.00 so far, no month_total.
-- 2026-10-16 wants, tomorrow: no amount, the same usual values.
-- 2026-10-01 spendable_income: August 3000.00 and September 2000.00 both
--   landed on the 1st. Usual 5000.00 / 3 = 1666.67, share 1.0000.
-- 2026-10-31 needs: July 31 3.75, August 31 1400.00, and September's last
--   day, the 30th, 310.00. Usual 1713.75 / 3 = 571.25, share 1.0000.
-- 2026-06-01 variable_needs: June's rent is recurring, so not variable;
--   May's rent on the 1st is not linked to a series, so it is. Usual
--   (0 + 0 + 600.00) / 3 = 200.00, share 1.0000 (March and April total 0).
-- 2026-06-30 variable_needs: June's 30.25 + 7.50 receipt lines = 37.75,
--   which is also its month_total.
-- 2026-03-15 needs: the first month of the list has no baseline.
{{ config(tags=['fixture']) }}

with expected (date_day, series, col, value) as (
    values
        (date '2026-09-30', 'financial_future', 'amount_mtd', 150.00),
        (date '2026-09-30', 'financial_future', 'month_total', 150.00),
        (date '2026-09-30', 'financial_future', 'pace_mtd_avg_3m', 383.33),
        (date '2026-09-30', 'financial_future', 'pace_share_avg_3m', 1.0000),
        (date '2026-09-29', 'financial_future', 'amount_mtd', 0.00),
        (date '2026-09-29', 'financial_future', 'pace_mtd_avg_3m', 216.67),
        (date '2026-09-29', 'financial_future', 'pace_share_avg_3m', 0.5000),
        (date '2026-10-15', 'wants', 'amount_day', 0.00),
        (date '2026-10-15', 'wants', 'amount_mtd', 0.00),
        (date '2026-10-15', 'wants', 'month_total', null),
        (date '2026-10-15', 'wants', 'pace_mtd_avg_3m', 233.33),
        (date '2026-10-15', 'wants', 'pace_share_avg_3m', 1.0000),
        (date '2026-10-16', 'wants', 'amount_day', null),
        (date '2026-10-16', 'wants', 'amount_mtd', null),
        (date '2026-10-16', 'wants', 'pace_mtd_avg_3m', 233.33),
        (date '2026-10-16', 'wants', 'pace_share_avg_3m', 1.0000),
        (date '2026-10-01', 'spendable_income', 'pace_mtd_avg_3m', 1666.67),
        (date '2026-10-01', 'spendable_income', 'pace_share_avg_3m', 1.0000),
        (date '2026-10-31', 'needs', 'amount_mtd', null),
        (date '2026-10-31', 'needs', 'pace_mtd_avg_3m', 571.25),
        (date '2026-10-31', 'needs', 'pace_share_avg_3m', 1.0000),
        (date '2026-06-01', 'variable_needs', 'amount_mtd', 0.00),
        (date '2026-06-01', 'variable_needs', 'pace_mtd_avg_3m', 200.00),
        (date '2026-06-01', 'variable_needs', 'pace_share_avg_3m', 1.0000),
        (date '2026-06-30', 'variable_needs', 'amount_mtd', 37.75),
        (date '2026-06-30', 'variable_needs', 'month_total', 37.75),
        (date '2026-03-15', 'needs', 'pace_mtd_avg_3m', null),
        (date '2026-03-15', 'needs', 'pace_share_avg_3m', null)
),

actual (date_day, series, col, value) as (
    select d.date_day, d.series, v.col, v.value
    from {{ ref('fct_pace_day') }} as d
    cross join lateral (values
        ('amount_day', d.amount_day),
        ('amount_mtd', d.amount_mtd),
        ('month_total', d.month_total),
        ('pace_mtd_avg_3m', d.pace_mtd_avg_3m),
        ('pace_share_avg_3m', d.pace_share_avg_3m)
    ) as v (col, value)
)

select e.date_day, e.series, e.col, e.value as expected, a.value as actual
from expected as e
left join actual as a on a.date_day = e.date_day and a.series = e.series and a.col = e.col
where a.date_day is null or e.value is distinct from a.value

union all

-- Every day of 2026-03 to 2026-10, five series each.
select null, null, 'rows', (245 * 5)::numeric, count(*)
from {{ ref('fct_pace_day') }}
having count(*) <> 245 * 5
