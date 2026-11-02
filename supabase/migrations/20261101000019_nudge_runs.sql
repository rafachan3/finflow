-- Migration 0019: the daily digest's runs (Phase 4.5, scheduled nudge).
-- Contract: docs/DATA_MODEL.md and docs/ARCHITECTURE.md ("Scheduled nudges").
--
-- One row per Toronto day per chat. The nudge function claims the row before
-- it sends, so a retried or duplicated schedule finds it and sends nothing.
-- Only a definite Telegram refusal ('failed') may be claimed again, at most
-- three attempts in all. message_id is the sent digest: a tap on its buttons
-- finds the run by (chat_id, message_id) to redraw it for its day.
--
-- Grants: the default privileges of 0003 and 0013 make it readable by
-- finflow_readonly and finflow_dbt; nothing for the Data API roles (0015).

create table nudge_runs (
  run_date   date     not null,
  chat_id    bigint   not null,
  status     text     not null check (status in ('claimed', 'sent', 'empty', 'failed')),
  attempts   smallint not null default 1 check (attempts between 1 and 3),
  message_id integer,
  updated_at timestamptz not null default now(),
  primary key (run_date, chat_id),
  check ((status = 'sent') = (message_id is not null))
);

create unique index nudge_runs_message_key on nudge_runs (chat_id, message_id)
  where message_id is not null;
