-- Migration 0002: generic taxonomy seed. Contract: docs/TAXONOMY.md — the
-- two must agree; change both in the same commit.
--
-- This is the fork-ready template. Personal lookup values (accounts, income
-- sources, additional funding sources, personal tags, merchants) are NOT
-- here — they live in the untracked supabase/seed.personal.sql overlay; see
-- supabase/seed.personal.example.sql for the format.

insert into categories (name) values
  ('Bills'),
  ('Food and drink'),
  ('Health and wellness'),
  ('Housing'),
  ('Finances'),
  ('Personal'),
  ('Career and professional'),
  ('Shopping'),
  ('Transportation'),
  ('Travel'),
  ('Immigration and legal');

-- default_bucket is an extraction hint only (null = no default; the LLM and
-- the human decide per line). The authoritative bucket is on each
-- transaction_items row.
insert into subcategories (category_id, name, default_bucket)
select c.id, s.name, s.default_bucket::bucket_type
from (values
  ('Bills', 'Internet and phone',                 'needs'),
  ('Bills', 'Utilities',                          'needs'),
  ('Bills', 'Other bills',                        null),

  ('Food and drink', 'Groceries',                 null),
  ('Food and drink', 'Restaurants',               'wants'),
  ('Food and drink', 'Takeout / Quick Service',   'wants'),
  ('Food and drink', 'Delivery',                  'wants'),
  ('Food and drink', 'Bars and nightlife',        'wants'),
  ('Food and drink', 'Other food and drink',      null),

  ('Health and wellness', 'Fitness',              null),
  ('Health and wellness', 'Medical',              'needs'),
  ('Health and wellness', 'Hygiene',              'needs'),
  ('Health and wellness', 'Other health',         null),

  ('Housing', 'Rent',                             'needs'),
  ('Housing', 'Home and renter''s insurance',     'needs'),
  ('Housing', 'Mortgage',                         'needs'),
  ('Housing', 'Household supplies',               'needs'),
  ('Housing', 'Household goods',                  null),
  ('Housing', 'Laundry',                          'needs'),
  ('Housing', 'Property taxes',                   'needs'),
  ('Housing', 'Other housing',                    null),

  ('Finances', 'Financial fees',                  'needs'),
  ('Finances', 'Taxes',                           'needs'),
  ('Finances', 'Personal loans',                  'needs'),
  ('Finances', 'Student loans',                   'needs'),
  ('Finances', 'Other finances',                  null),

  ('Personal', 'Beauty',                          'wants'),
  ('Personal', 'Entertainment and activities',    'wants'),
  ('Personal', 'Hobbies',                         'wants'),
  ('Personal', 'Bets',                            'wants'),
  ('Personal', 'Pets',                            null),
  ('Personal', 'Other personal',                  null),

  ('Career and professional', 'Education and training',            null),
  ('Career and professional', 'Software and digital',              null),
  ('Career and professional', 'Equipment',                         null),
  ('Career and professional', 'Certifications and career',         null),
  ('Career and professional', 'Other career and professional',     null),

  ('Shopping', 'Clothing and accessories',        'wants'),
  ('Shopping', 'Gifts',                           'wants'),
  ('Shopping', 'Memberships',                     'wants'),
  ('Shopping', 'Other shopping',                  null),

  ('Transportation', 'Auto insurance',            'needs'),
  ('Transportation', 'Maintenance',               'needs'),
  ('Transportation', 'Car loan payments',         'needs'),
  ('Transportation', 'Gas, parking and tolls',    'needs'),
  ('Transportation', 'Public transit',            'needs'),
  ('Transportation', 'Taxis and rideshares',      'wants'),
  ('Transportation', 'Other transportation',      null),

  ('Travel', 'Flights',                           null),
  ('Travel', 'Hotels',                            null),
  ('Travel', 'Other travel',                      null),

  ('Immigration and legal', 'Immigration',                        'needs'),
  ('Immigration and legal', 'Government IDs and documents',       'needs'),
  ('Immigration and legal', 'Legal and professional services',    'needs'),
  ('Immigration and legal', 'Other immigration and legal',        null)
) as s(category, name, default_bucket)
join categories c on c.name = s.category;

-- Item types exist only where subcategory (channel / financial function)
-- and item type (what the thing is) answer different questions.
insert into item_types (category_id, name)
select c.id, t.name
from (values
  ('Food and drink', 'Ingredients & Staples'),
  ('Food and drink', 'Meals & Prepared Food'),
  ('Food and drink', 'Snacks & Sweets'),
  ('Food and drink', 'Non-Alcoholic Beverages'),
  ('Food and drink', 'Alcoholic Beverages'),
  ('Food and drink', 'Other Food & Drink'),

  ('Housing', 'Cleaning Product'),
  ('Housing', 'Paper Product'),
  ('Housing', 'Laundry Supply'),
  ('Housing', 'Kitchenware'),
  ('Housing', 'Bedding'),
  ('Housing', 'Small Appliance'),
  ('Housing', 'Furniture'),

  ('Health and wellness', 'Oral Care'),
  ('Health and wellness', 'Body Care'),
  ('Health and wellness', 'Medication'),
  ('Health and wellness', 'Medical Device'),
  ('Health and wellness', 'Equipment'),
  ('Health and wellness', 'Membership')
) as t(category, name)
join categories c on c.name = t.category;

insert into venues (name) values
  ('Supermarket'),
  ('Dépanneur'),
  ('Coffee Shop'),
  ('Fast Food'),
  ('Pharmacy'),
  ('Instacart'),
  ('Too Good To Go');

insert into tags (name) values
  ('Travel'),
  ('Social'),
  ('Emergency'),
  ('Work-related'),
  ('Avoidable'),
  ('Concert');

insert into funding_sources (name) values
  ('self');
