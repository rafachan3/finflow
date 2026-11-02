-- Variant of synthetic.sql, loaded after it: a ledger with the problems
-- the ledger health tests look for, next to near misses they must leave
-- alone. CI loads it and expects occurred_on_within_ledger to fail (2 rows)
-- and no_likely_duplicates and recurring_flag_has_series to warn (1 row
-- each), and nothing else. The base fixture is the passing case of all
-- three. Invented rows only.
--
--   c...01  dated years before the fixture's ledger start      fails
--   c...02  dated years in the future                          fails
--   c...03  "Metro ticket" 3.75 on 07-10                       } one pair:
--   c...04  "metro  ticket " 3.75 on 07-11 (case, spaces)      } warns
--   c...05  "Metro ticket" 3.75 on 07-16, 5 days later         no pair
--   c...06  "Washer" 400.00 on 07-20                           } same price,
--   c...07  "Dryer" 400.00 on 07-20                            } no pair
--   c...08  income flagged recurring, linked to no series      warns
insert into transactions (id, occurred_on, type, amount, description, funding_source_id, income_source_id, is_recurring)
select v.id::uuid, v.occurred_on::date, v.type::transaction_type, v.amount, v.description, f.id, s.id, v.is_recurring
from (values
    ('c0000000-0000-0000-0000-000000000001', '2022-07-14', 'expense',   9.00, 'Bus pass',        'self', null::text, false),
    ('c0000000-0000-0000-0000-000000000002', '2099-07-14', 'expense',   9.00, 'Train ticket',    'self', null,       false),
    ('c0000000-0000-0000-0000-000000000003', '2026-07-10', 'expense',   3.75, 'Metro ticket',    'self', null,       false),
    ('c0000000-0000-0000-0000-000000000004', '2026-07-11', 'expense',   3.75, 'metro  ticket ',  'self', null,       false),
    ('c0000000-0000-0000-0000-000000000005', '2026-07-16', 'expense',   3.75, 'Metro ticket',    'self', null,       false),
    ('c0000000-0000-0000-0000-000000000006', '2026-07-20', 'expense', 400.00, 'Washer',          'self', null,       false),
    ('c0000000-0000-0000-0000-000000000007', '2026-07-20', 'expense', 400.00, 'Dryer',           'self', null,       false),
    ('c0000000-0000-0000-0000-000000000008', '2026-07-25', 'income',  100.00, 'Side job',        null,   'Salary',   true)
) as v (id, occurred_on, type, amount, description, funder, income_source, is_recurring)
left join funding_sources as f on f.name = v.funder
left join income_sources as s on s.name = v.income_source;

-- One line each, so the expense invariants still hold.
insert into transaction_items (transaction_id, description, amount, subcategory_id, bucket)
select t.id, t.description, t.amount, sc.id, 'needs'
from transactions as t
join categories as c on c.name = 'Transportation'
join subcategories as sc on sc.category_id = c.id and sc.name = 'Public transit'
where t.id::text like 'c0000000-%' and t.type = 'expense';
