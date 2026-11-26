-- Migration 0027: a card's topic and message, and topics to tidy up
-- (Telegram topics, Stage 1).
-- Contract: docs/DATA_MODEL.md.
--
-- Each purchase card lives in its own Telegram topic. ingestions remembers
-- the topic (telegram_thread_id) and the card the owner taps or replies to
-- (card_message_id). utility_topics lists the topics a command or a message
-- with no purchase opened, so the webhook can delete them an hour later.
--
-- Grants: the default privileges of 0003 and 0013 make utility_topics
-- readable by finflow_readonly and finflow_dbt; nothing for the Data API
-- roles (0015).

alter table ingestions
  add column telegram_thread_id integer,  -- the purchase's topic; null before topics, or when its card shares another purchase's topic
  add column card_message_id   integer;   -- the card the owner taps or replies to; null until a card is sent

create index ingestions_thread_idx on ingestions (telegram_thread_id)
  where telegram_thread_id is not null;

create table utility_topics (
  chat_id   bigint      not null,
  thread_id integer     not null,
  label     text        not null check (length(label) between 1 and 64),
  opened_at timestamptz not null default now(),
  primary key (chat_id, thread_id)
);
