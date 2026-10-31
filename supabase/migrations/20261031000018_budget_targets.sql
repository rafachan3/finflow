-- Migration 0018: the 50/30/20 budget targets.
-- Contract: docs/SEMANTIC_LAYER.md ("Targets") and docs/DATA_MODEL.md.
--
-- One row: the share of spendable income a person aims to keep needs and
-- wants under, and to set aside as financial future, as percentages 0-100
-- that sum to 100. The tracked default is 50/30/20; a person changes it with
-- an UPDATE in their untracked seed overlay (supabase/seed.personal.example.sql
-- shows how). dbt reads it as a source and exposes each as a fraction. No
-- effective dates: a change restates every month on the next rebuild.
--
-- Grants: the default privileges of 0003 and 0013 make this table readable by
-- finflow_readonly and finflow_dbt. 0015 removed the migrating role's default
-- privileges for anon and authenticated, so it is not granted to them (dbt
-- test data_api_roles_reach_nothing).

create table budget_targets (
  -- Always true: the primary key allows one row only.
  id                       boolean primary key default true check (id),
  needs_percent            numeric(5,2) not null check (needs_percent between 0 and 100),
  wants_percent            numeric(5,2) not null check (wants_percent between 0 and 100),
  financial_future_percent numeric(5,2) not null check (financial_future_percent between 0 and 100),
  check (needs_percent + wants_percent + financial_future_percent = 100)
);

insert into budget_targets (needs_percent, wants_percent, financial_future_percent)
values (50, 30, 20);
