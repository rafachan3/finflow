-- The fixture pins Toronto's today to 2026-10-15 (var today, set by
-- test_db.py), so whatever the real date its month list ends at 2026-10,
-- which is the current month (incomplete), and every month before it is
-- complete. Returns each month that breaks that. Tagged `fixture`.
{{ config(tags=['fixture']) }}

select month_start, is_complete_month
from {{ ref('fct_monthly_summary') }}
where month_start > date '2026-10-01'
   or is_complete_month is distinct from (month_start < date '2026-10-01')

union all

select date '2026-10-01', null
where not exists (
    select 1 from {{ ref('fct_monthly_summary') }} where month_start = date '2026-10-01'
)
