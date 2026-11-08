-- fct_subcategory_month on the fixture against values worked out by hand
-- from fixtures/synthetic.sql, with today pinned to 2026-10-15. Tagged
-- `fixture`.
--
-- Own spend lines by (bucket, subcategory), 2026-03 to 2026-10: needs Rent
-- (05 600.00, 06 1200.00, 08 1400.00), Groceries (06 30.25), Household
-- supplies (06 7.50), Public transit (07 3.75), Utilities (09 60.00), Car
-- loan payments (09 250.00); wants Restaurants (05 400.00, 08 700.00;
-- June's 80.00 dinner someone else paid for is not own), Memberships (06
-- 15.99), Groceries (06 9.75), Takeout / Quick Service (06 12.40). That is
-- 10 pairs over 8 months: 80 rows.
--
-- 2026-03 needs Rent: the first month, no baseline, so no mean or delta;
--   few lines (0 lines).
-- 2026-06 wants Restaurants: 0.00 and 0 lines, the 80.00 is not own.
-- 2026-08 needs Rent: 1400.00, 1 line; baseline May 600.00, June 1200.00,
--   July 0 -> 600.00, delta 800.00; lines (1 + 1 + 0) / 3 = 0.6667; few
--   lines, 1 + 3 * 0.6667 = 3 < 6.
-- 2026-09 wants Restaurants: absent, so 0.00 and 0 lines; baseline June 0,
--   July 0, August 700.00 -> 233.333... = 233.33, delta -233.33; lines
--   0.3333.
-- 2026-10 needs Rent, current and empty: baseline July 0, August 1400.00,
--   September 0 -> 466.666... = 466.67, delta -466.67.
{{ config(tags=['fixture']) }}

with expected (month_start, bucket, subcategory_name, col, value) as (
    values
        (date '2026-03-01', 'needs', 'Rent', 'spend', 0.00),
        (date '2026-03-01', 'needs', 'Rent', 'baseline_months', 0),
        (date '2026-03-01', 'needs', 'Rent', 'spend_avg_3m', null),
        (date '2026-03-01', 'needs', 'Rent', 'line_count_avg_3m', null),
        (date '2026-03-01', 'needs', 'Rent', 'spend_delta', null),
        (date '2026-03-01', 'needs', 'Rent', 'is_few_lines', 1),
        (date '2026-06-01', 'wants', 'Restaurants', 'spend', 0.00),
        (date '2026-06-01', 'wants', 'Restaurants', 'line_count', 0),
        (date '2026-08-01', 'needs', 'Rent', 'spend', 1400.00),
        (date '2026-08-01', 'needs', 'Rent', 'line_count', 1),
        (date '2026-08-01', 'needs', 'Rent', 'baseline_months', 3),
        (date '2026-08-01', 'needs', 'Rent', 'spend_avg_3m', 600.00),
        (date '2026-08-01', 'needs', 'Rent', 'spend_delta', 800.00),
        (date '2026-08-01', 'needs', 'Rent', 'line_count_avg_3m', 0.6667),
        (date '2026-08-01', 'needs', 'Rent', 'is_few_lines', 1),
        (date '2026-09-01', 'wants', 'Restaurants', 'spend', 0.00),
        (date '2026-09-01', 'wants', 'Restaurants', 'line_count', 0),
        (date '2026-09-01', 'wants', 'Restaurants', 'spend_avg_3m', 233.33),
        (date '2026-09-01', 'wants', 'Restaurants', 'spend_delta', -233.33),
        (date '2026-09-01', 'wants', 'Restaurants', 'line_count_avg_3m', 0.3333),
        (date '2026-10-01', 'needs', 'Rent', 'spend', 0.00),
        (date '2026-10-01', 'needs', 'Rent', 'spend_avg_3m', 466.67),
        (date '2026-10-01', 'needs', 'Rent', 'spend_delta', -466.67)
),

actual (month_start, bucket, subcategory_name, col, value) as (
    select s.month_start, s.bucket, s.subcategory_name, v.col, v.value
    from {{ ref('fct_subcategory_month') }} as s
    cross join lateral (values
        ('spend', s.spend),
        ('line_count', s.line_count::numeric),
        ('baseline_months', s.baseline_months::numeric),
        ('spend_avg_3m', s.spend_avg_3m),
        ('line_count_avg_3m', s.line_count_avg_3m),
        ('spend_delta', s.spend_delta),
        ('is_few_lines', s.is_few_lines::integer::numeric)
    ) as v (col, value)
)

select e.month_start, e.bucket, e.subcategory_name, e.col, e.value as expected, a.value as actual
from expected as e
left join actual as a
    on a.month_start = e.month_start and a.bucket = e.bucket
   and a.subcategory_name = e.subcategory_name and a.col = e.col
where a.month_start is null or e.value is distinct from a.value

union all

select null, null, null, 'rows', 80, count(*)
from {{ ref('fct_subcategory_month') }}
having count(*) <> 80
