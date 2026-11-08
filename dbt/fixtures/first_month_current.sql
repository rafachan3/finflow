-- Variant of synthetic.sql, loaded after it, run with the ledger start at
-- 2026-10-01 and today pinned to 2026-10-31: a ledger whose first month is
-- the current one, as production's was in its first month. Every row
-- before October goes; October gets a 2000.00 paycheque and tomorrow,
-- 2026-11-01, a 1000.00 one, which makes November a later month
-- (as_of_day 0). Neither month has a complete month before it, so
-- fct_month_plan must expect no income in both, not the income so far.
-- CI loads it and expects `dbt build --exclude tag:fixture` to pass
-- (month_plan_matches_targets). Invented rows only.
delete from ingestions;
delete from transactions where occurred_on < '2026-10-01';

insert into transactions (id, occurred_on, type, amount, description, income_source_id)
select v.id::uuid, v.occurred_on::date, 'income', v.amount, 'Paycheque', s.id
from (values
    ('d0000000-0000-0000-0000-000000000011', '2026-10-01', 2000.00),
    ('d0000000-0000-0000-0000-000000000012', '2026-11-01', 1000.00)
) as v (id, occurred_on, amount)
cross join income_sources as s
where s.name = 'Salary';
