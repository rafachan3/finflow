-- Variant of synthetic.sql, loaded after it: an October paycheque of
-- 2500.00 on 2026-10-14, the day before the pinned today. October's
-- baseline (July 0, August 3000.00, September 2000.00) is 1666.67, so
-- income so far is above it and fct_month_plan must expect 2500.00, not
-- the baseline. CI loads it and expects `dbt build --exclude tag:fixture`
-- to pass (month_plan_matches_targets). Invented rows only.
insert into transactions (id, occurred_on, type, amount, description, income_source_id)
select 'd0000000-0000-0000-0000-000000000001', '2026-10-14', 'income', 2500.00, 'Paycheque', id
from income_sources where name = 'Salary';
