-- Variant of synthetic.sql, loaded after it: a ledger with the problems
-- the ledger health tests look for, next to near misses they must leave
-- alone. CI loads it and expects occurred_on_within_ledger to fail (2 rows),
-- no_likely_duplicates to warn (1 row) and likely_duplicates_reworded to
-- warn (2 rows), and nothing else. The base fixture is the passing case of
-- all three. Invented rows only.
--
--   c...01  dated years before the fixture's ledger start      fails
--   c...02  dated years in the future                          fails
--   c...03  "Metro ticket" 3.75 on 07-10                       } one pair:
--   c...04  "metro  ticket " 3.75 on 07-11 (case, spaces)      } warns
--   c...05  "Metro ticket" 3.75 on 07-16, 5 days later         no pair
--   c...06  "Washer" 400.00 on 07-20                           } same price, a reworded
--   c...07  "Dryer" 400.00 on 07-20                            } pair, acknowledged
--   c...08  "Concert ticket" 45.00 on 07-24                    } a pair the
--   c...09  "Concert ticket" 45.00 on 07-24                    } owner acknowledged
--   c...10  "Corner Grocer Inc" 23.40 on 07-22, photo          } one receipt,
--   c...11  "Bread and cheese" 23.40 on 07-23, photo           } reworded: warns
--   c...12  "Laundry washer" 2.50 on 07-30, imported           } under 3.00, both
--   c...13  "Laundry dryer" 2.50 on 07-30, imported            } imported: quiet
--   c...14  "Coffee" 2.50 on 07-26, text                       } under 3.00, one
--   c...15  "Muffin" 2.50 on 07-26, imported                   } logged: warns
--   c...16  "Gym" 30.00 on 07-27                               } one recurring
--   c...17  "Gym fee" 30.00 on 07-28                           } series: quiet
insert into transactions (id, occurred_on, type, amount, description, funding_source_id)
select v.id::uuid, v.occurred_on::date, v.type::transaction_type, v.amount, v.description, f.id
from (values
    ('c0000000-0000-0000-0000-000000000001', '2022-07-14', 'expense',   9.00, 'Bus pass',        'self'),
    ('c0000000-0000-0000-0000-000000000002', '2099-07-14', 'expense',   9.00, 'Train ticket',    'self'),
    ('c0000000-0000-0000-0000-000000000003', '2026-07-10', 'expense',   3.75, 'Metro ticket',    'self'),
    ('c0000000-0000-0000-0000-000000000004', '2026-07-11', 'expense',   3.75, 'metro  ticket ',  'self'),
    ('c0000000-0000-0000-0000-000000000005', '2026-07-16', 'expense',   3.75, 'Metro ticket',    'self'),
    ('c0000000-0000-0000-0000-000000000006', '2026-07-20', 'expense', 400.00, 'Washer',          'self'),
    ('c0000000-0000-0000-0000-000000000007', '2026-07-20', 'expense', 400.00, 'Dryer',           'self'),
    ('c0000000-0000-0000-0000-000000000008', '2026-07-24', 'expense',  45.00, 'Concert ticket',  'self'),
    ('c0000000-0000-0000-0000-000000000009', '2026-07-24', 'expense',  45.00, 'Concert ticket',  'self'),
    ('c0000000-0000-0000-0000-000000000010', '2026-07-22', 'expense',  23.40, 'Corner Grocer Inc', 'self'),
    ('c0000000-0000-0000-0000-000000000011', '2026-07-23', 'expense',  23.40, 'Bread and cheese', 'self'),
    ('c0000000-0000-0000-0000-000000000012', '2026-07-30', 'expense',   2.50, 'Laundry washer',  'self'),
    ('c0000000-0000-0000-0000-000000000013', '2026-07-30', 'expense',   2.50, 'Laundry dryer',   'self'),
    ('c0000000-0000-0000-0000-000000000014', '2026-07-26', 'expense',   2.50, 'Coffee',          'self'),
    ('c0000000-0000-0000-0000-000000000015', '2026-07-26', 'expense',   2.50, 'Muffin',          'self'),
    ('c0000000-0000-0000-0000-000000000016', '2026-07-27', 'expense',  30.00, 'Gym',             'self'),
    ('c0000000-0000-0000-0000-000000000017', '2026-07-28', 'expense',  30.00, 'Gym fee',         'self')
) as v (id, occurred_on, type, amount, description, funder)
left join funding_sources as f on f.name = v.funder;

-- One line each, so the expense invariants still hold.
insert into transaction_items (transaction_id, description, amount, subcategory_id, bucket)
select t.id, t.description, t.amount, sc.id, 'needs'
from transactions as t
join categories as c on c.name = 'Transportation'
join subcategories as sc on sc.category_id = c.id and sc.name = 'Public transit'
where t.id::text like 'c0000000-%' and t.type = 'expense';

insert into duplicate_acknowledgements (first_id, second_id)
values ('c0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000007'),
       ('c0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000009');

-- Bot-logged rows: the confirmed ingestion each came from (two photos of
-- one receipt, and one typed snack). The rest are history imports.
insert into ingestions (source, telegram_update_id, event_index, raw_payload, media_path, status, transaction_id, created_at)
values
    ('photo', 9010, 0, '{}', 'photo/2026-07/9010.jpg', 'confirmed', 'c0000000-0000-0000-0000-000000000010', '2026-07-22 18:00+00'),
    ('photo', 9011, 0, '{}', 'photo/2026-07/9011.jpg', 'confirmed', 'c0000000-0000-0000-0000-000000000011', '2026-07-23 18:00+00'),
    ('text',  9014, 0, '{}', null,                     'confirmed', 'c0000000-0000-0000-0000-000000000014', '2026-07-26 14:00+00');

-- Linking sets is_recurring (migration 0016's trigger).
insert into recurring_series (name, kind, cadence) values ('Gym membership', 'expense', 'monthly');
update transactions
set recurring_series_id = (select id from recurring_series where name = 'Gym membership')
where id in ('c0000000-0000-0000-0000-000000000016', 'c0000000-0000-0000-0000-000000000017');
