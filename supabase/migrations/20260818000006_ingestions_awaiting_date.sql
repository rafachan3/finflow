-- Migration 0006: Fix date waits on the pending ingestion instead of a
-- new Telegram expense. awaiting_date means the next text from the owner
-- is a date for this row, not a new extraction.

alter table ingestions drop constraint ingestions_status_check;

alter table ingestions add constraint ingestions_status_check
  check (status in ('pending', 'awaiting_date', 'confirmed', 'discarded'));
