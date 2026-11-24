-- Migration 0025: the delivery apps DoorDash and Uber Eats are venues.
-- Contract: docs/TAXONOMY.md ("Venues").
--
-- A venue is the place type or the channel of a purchase. Instacart and Too
-- Good To Go were seeded as channels; the two delivery apps were added to the
-- live database by hand and never seeded, so a fresh database could not
-- offer them to the extractor. An order placed on one of them takes the app
-- as its venue; the restaurant stays the merchant.
--
-- Down: delete from venues where name in ('DoorDash', 'Uber Eats');
--       (only while no transaction references them)

insert into venues (name) values
  ('DoorDash'),
  ('Uber Eats')
on conflict (name) do nothing;
