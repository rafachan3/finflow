-- Migration 0005: merge Hygiene (Health and wellness) and Beauty (Personal)
-- into a single subcategory "Personal care" under Health and wellness.
-- Contract: docs/TAXONOMY.md — change both in the same commit.
--
-- Critical: do not touch transaction_items.bucket (or any other column).
-- The merged subcategory is expected to contain a mix of needs and wants;
-- that mix is the point of decoupling taxonomy from Need/Want.

insert into subcategories (category_id, name, default_bucket)
select c.id, 'Personal care', null
from categories c
where c.name = 'Health and wellness';

update transaction_items ti
set subcategory_id = pc.id
from subcategories pc
join categories hc on hc.id = pc.category_id and hc.name = 'Health and wellness'
where pc.name = 'Personal care'
  and ti.subcategory_id in (
    select s.id
    from subcategories s
    join categories c on c.id = s.category_id
    where (c.name = 'Health and wellness' and s.name = 'Hygiene')
       or (c.name = 'Personal' and s.name = 'Beauty')
  );

delete from subcategories s
using categories c
where s.category_id = c.id
  and (
    (c.name = 'Health and wellness' and s.name = 'Hygiene')
    or (c.name = 'Personal' and s.name = 'Beauty')
  );
