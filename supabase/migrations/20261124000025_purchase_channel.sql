-- Migration 0025: venue is the kind of place; channel is the app it went through.
-- Contract: docs/DATA_MODEL.md ("channels"), docs/TAXONOMY.md ("Venue and channel").
--
-- venues answered two questions at once: what kind of place sold it and how
-- it was bought. A channel is the app or service a purchase went through
-- (DoorDash, Instacart, ...); null means bought directly, including through
-- the restaurant's own app or site. Rows whose venue was a channel keep it as
-- their channel and lose that venue: a channel never says what kind of place
-- sold it, so the venue is left empty for the owner to fill in.
--
-- Idempotent: a second run finds no channel left among the venues.
-- Grants: the default privileges of 0003 and 0013 make channels readable by
-- finflow_readonly and finflow_dbt; nothing for the Data API roles (0015).
--
-- Down: re-insert the channel names into venues, set each moved row's
--   venue_id from its channel by name, then drop transactions.channel_id
--   and the channels table.

create table if not exists channels (
  id   smallint generated always as identity primary key,
  name text not null unique
);

insert into channels (name) values
  ('DoorDash'),
  ('Uber Eats'),
  ('Instacart'),
  ('Too Good To Go')
on conflict (name) do nothing;

alter table transactions
  add column if not exists channel_id smallint references channels(id);

update transactions t
set channel_id = c.id, venue_id = null
from venues v
join channels c on c.name = v.name
where t.venue_id = v.id;

delete from venues v
using channels c
where c.name = v.name;
