-- Migration 0011: the business a re-read of the archived photo or voice note
-- names, for confirmed ingestions whose extraction recorded no merchant.
-- Written once by a one-off backfill script (lambda/scripts), never by the
-- Lambda. NULL means not read, or the media names no business. /addmerchant
-- links a transaction whose ingestion's media_merchant equals the name.

alter table ingestions add column media_merchant text;
