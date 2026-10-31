-- Migration 0017: a debt account kind (a car loan, a mortgage).
-- Contract: docs/DATA_MODEL.md and docs/SEMANTIC_LAYER.md.
--
-- An extra payment on a loan is a transfer from chequing into a debt
-- account. A debt account has no balance and only receives transfers: a
-- transfer out of one, or an income source depositing into one, fails a dbt
-- test (dbt/tests/debt_account_only_receives_transfers.sql), since a CHECK
-- cannot read another table.

alter table accounts
  drop constraint accounts_kind_check;

alter table accounts
  add constraint accounts_kind_check
  check (kind in ('savings', 'investment', 'debt'));
