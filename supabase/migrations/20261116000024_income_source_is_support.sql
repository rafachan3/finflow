-- Migration 0024: an income source can be marked as support.
-- Contract: docs/DATA_MODEL.md ("income_sources").
--
-- Support is money another person gives regularly toward living costs. It
-- is income like any other in every metric; the flag only lets a dashboard
-- ask what a month would have looked like without it. The tracked seed
-- leaves every source false; the owner sets it in the database, like the
-- other personal values, so no source name reaches this repo.
--
-- Down: alter table income_sources drop column is_support;

alter table income_sources
  add column if not exists is_support boolean not null default false;
