-- Migration 0022: one-off opening balance per account.
-- Contract: docs/DATA_MODEL.md; how to add one: docs/TESTING.md.
--
-- The mart turns this into a savings balance (opening plus flows after
-- as_of). Investment accounts stay contributed-since-tracking; debt
-- accounts have no balance. Values live in the database, never in the
-- public repo: the owner runs a placeholder snippet in the Supabase
-- SQL editor.
--
-- Grants: the default privileges of 0003 and 0013 make it readable by
-- finflow_readonly and finflow_dbt; nothing for finflow_analyst (it
-- reads marts only) or the Data API roles (0015).

create table account_opening_balances (
  account_id smallint      not null references accounts(id) on delete cascade,
  as_of      date          not null,
  amount     numeric(12,2) not null,
  primary key (account_id)
);
