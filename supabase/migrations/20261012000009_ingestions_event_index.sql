-- Migration 0009: one Telegram update can carry several ledger events
-- (multi-event). Each event is its own ingestions row. event_index orders
-- the events within the update; (telegram_update_id, event_index) keeps
-- webhook retries idempotent. Existing rows are event 0.

alter table ingestions
  add column event_index smallint not null default 0
  check (event_index >= 0);

alter table ingestions
  drop constraint ingestions_telegram_update_id_key;

alter table ingestions
  add constraint ingestions_telegram_update_id_event_index_key
  unique (telegram_update_id, event_index);
