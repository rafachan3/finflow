-- Synthetic ledger for dbt in CI and local runs. Loaded by
-- scripts/test_db.py after the migrations and
-- supabase/seed.personal.example.sql, so every name is the tracked
-- taxonomy's or the example seed's placeholder. Never add an owner value.
--
-- Fixed ids, so a variant can patch one row (off_by_a_cent.sql):
-- transactions a0..., lines b0..., in the order below.
--
-- 2026-06, the sample month: salary and refund income; a recurring needs
-- line (Rent) and a recurring wants line; an expense someone else paid
-- for; a three-line receipt with mixed buckets, one line tag and one header
-- tag; transfers to both account kinds, one tagged; imported rows and
-- photo, voice and text rows; an expense dated 06-30 confirmed from a
-- message sent 07-01 03:00 UTC (still 06-30 in Toronto); interest paid
-- straight into savings, a withdrawal back to chequing and a move between
-- two accounts (migration 0014, a...13 to a...15).
-- 2026-07: one expense on 07-01. 2026-08: income only. 2026-09: needs
-- spend only, no income.

insert into transactions (
    id, occurred_on, type, amount, description, is_recurring, notes,
    funding_source_id, income_source_id, to_account_id, merchant_id, venue_id
)
select
    v.id::uuid, v.occurred_on::date, v.type::transaction_type, v.amount,
    v.description, v.is_recurring, v.notes, f.id, s.id, a.id, m.id, ve.id
from (values
    ('a0000000-0000-0000-0000-000000000001', '2026-06-01', 'income',   3000.00, 'Paycheque',             true,  null::text,         null::text, 'Salary', null::text,           null::text,  null::text),
    ('a0000000-0000-0000-0000-000000000002', '2026-06-15', 'income',     25.00, 'Returned item',         false, null,               null,       'Refund', null,                 null,        null),
    ('a0000000-0000-0000-0000-000000000003', '2026-06-01', 'expense',  1200.00, 'June rent',             true,  null,               'self',     null,     null,                 null,        null),
    ('a0000000-0000-0000-0000-000000000004', '2026-06-05', 'expense',    15.99, 'Streaming subscription', true, null,               'self',     null,     null,                 null,        null),
    ('a0000000-0000-0000-0000-000000000005', '2026-06-10', 'expense',    80.00, 'Dinner out',            false, 'Birthday dinner',  'family',   null,     null,                 null,        null),
    ('a0000000-0000-0000-0000-000000000006', '2026-06-20', 'expense',    47.50, 'Weekly shop',           false, null,               'self',     null,     null,                 'Acme Mart', 'Supermarket'),
    ('a0000000-0000-0000-0000-000000000007', '2026-06-30', 'expense',    12.40, 'Late lunch',            false, null,               'self',     null,     null,                 null,        'Fast Food'),
    ('a0000000-0000-0000-0000-000000000008', '2026-06-25', 'transfer',  500.00, 'To emergency fund',     false, null,               null,       null,     'Emergency fund',     null,        null),
    ('a0000000-0000-0000-0000-000000000009', '2026-06-26', 'transfer',  300.00, 'To retirement account', false, null,               null,       null,     'Retirement account', null,        null),
    ('a0000000-0000-0000-0000-000000000010', '2026-07-01', 'expense',     3.75, 'Bus fare',              false, null,               'self',     null,     null,                 null,        null),
    ('a0000000-0000-0000-0000-000000000011', '2026-08-01', 'income',   3000.00, 'Paycheque',             true,  null,               null,       'Salary', null,                 null,        null),
    ('a0000000-0000-0000-0000-000000000012', '2026-09-03', 'expense',    60.00, 'Electricity bill',      true,  null,               'self',     null,     null,                 null,        null)
) as v (id, occurred_on, type, amount, description, is_recurring, notes, funder, income_source, account, merchant, venue)
left join funding_sources as f on f.name = v.funder
left join income_sources as s on s.name = v.income_source
left join accounts as a on a.name = v.account
left join merchants as m on m.name = v.merchant
left join venues as ve on ve.name = v.venue;

-- Money that does not start or end in chequing (null is chequing): a
-- source whose income lands in savings, a withdrawal (from set, to null)
-- and a move between two accounts that never touches chequing.
insert into income_sources (name, deposit_account_id)
select 'Savings interest', id from accounts where name = 'Emergency fund';

insert into transactions (
    id, occurred_on, type, amount, description, income_source_id, from_account_id, to_account_id
)
select v.id::uuid, v.occurred_on::date, v.type::transaction_type, v.amount, v.description, s.id, fa.id, ta.id
from (values
    ('a0000000-0000-0000-0000-000000000013', '2026-06-30', 'income',     4.12, 'Interest',                  'Savings interest', null::text,       null::text),
    ('a0000000-0000-0000-0000-000000000014', '2026-06-27', 'transfer', 150.00, 'Out of emergency fund',     null,               'Emergency fund', null),
    ('a0000000-0000-0000-0000-000000000015', '2026-06-29', 'transfer', 200.00, 'Emergency to retirement',   null,               'Emergency fund', 'Retirement account')
) as v (id, occurred_on, type, amount, description, income_source, from_account, to_account)
left join income_sources as s on s.name = v.income_source
left join accounts as fa on fa.name = v.from_account
left join accounts as ta on ta.name = v.to_account;

insert into transaction_items (id, transaction_id, description, amount, subcategory_id, item_type_id, bucket)
select v.id::uuid, v.transaction_id::uuid, v.description, v.amount, sc.id, it.id, v.bucket::bucket_type
from (values
    ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'Rent',          1200.00, 'Housing',        'Rent',                    null::text,              'needs'),
    ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'Streaming',       15.99, 'Shopping',       'Memberships',             null,                    'wants'),
    ('b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000005', 'Dinner',          80.00, 'Food and drink', 'Restaurants',             'Meals & Prepared Food', 'wants'),
    ('b0000000-0000-0000-0000-000000000061', 'a0000000-0000-0000-0000-000000000006', 'Rice and beans',  30.25, 'Food and drink', 'Groceries',               'Ingredients & Staples', 'needs'),
    ('b0000000-0000-0000-0000-000000000062', 'a0000000-0000-0000-0000-000000000006', 'Chocolate',        9.75, 'Food and drink', 'Groceries',               'Snacks & Sweets',       'wants'),
    ('b0000000-0000-0000-0000-000000000063', 'a0000000-0000-0000-0000-000000000006', 'Paper towels',     7.50, 'Housing',        'Household supplies',      'Paper Product',         'needs'),
    ('b0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000007', 'Burger combo',    12.40, 'Food and drink', 'Takeout / Quick Service', 'Meals & Prepared Food', 'wants'),
    ('b0000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000010', 'Bus fare',         3.75, 'Transportation', 'Public transit',          null,                    'needs'),
    ('b0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000012', 'Electricity',     60.00, 'Bills',          'Utilities',               null,                    'needs')
) as v (id, transaction_id, description, amount, category, subcategory, item_type, bucket)
join categories as c on c.name = v.category
join subcategories as sc on sc.category_id = c.id and sc.name = v.subcategory
left join item_types as it on it.category_id = c.id and it.name = v.item_type;

-- Header tags on an expense and on a transfer; a line tag on one receipt line.
insert into transaction_tags (transaction_id, tag_id)
select v.transaction_id::uuid, t.id
from (values
    ('a0000000-0000-0000-0000-000000000006', 'Travel'),
    ('a0000000-0000-0000-0000-000000000008', 'Emergency')
) as v (transaction_id, tag)
join tags as t on t.name = v.tag;

insert into transaction_item_tags (transaction_item_id, tag_id)
select 'b0000000-0000-0000-0000-000000000062'::uuid, id from tags where name = 'Partner';

-- Bot-era rows: the confirmed ingestion each came from. Rows without one
-- are history imports. The 06-30 lunch was sent 2026-07-01 03:00 UTC.
insert into ingestions (source, telegram_update_id, event_index, raw_payload, media_path, status, transaction_id, created_at)
values
    ('text',  1002, 0, '{}', null,                     'confirmed', 'a0000000-0000-0000-0000-000000000002', '2026-06-15 14:00+00'),
    ('voice', 1004, 0, '{}', 'voice/2026-06/1004.ogg', 'confirmed', 'a0000000-0000-0000-0000-000000000004', '2026-06-05 18:00+00'),
    ('photo', 1006, 0, '{}', 'photo/2026-06/1006.jpg', 'confirmed', 'a0000000-0000-0000-0000-000000000006', '2026-06-20 16:00+00'),
    ('text',  1007, 0, '{}', null,                     'confirmed', 'a0000000-0000-0000-0000-000000000007', '2026-07-01 03:00+00'),
    ('text',  1009, 0, '{}', null,                     'confirmed', 'a0000000-0000-0000-0000-000000000009', '2026-06-26 12:00+00');
