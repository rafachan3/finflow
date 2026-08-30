-- Migration 0007: funding_source is expense-only.
-- Who paid does not apply to income (income_source_id) or transfers
-- (to_account_id). Contract: docs/DATA_MODEL.md.

alter table transactions
  alter column funding_source_id drop not null;

update transactions
  set funding_source_id = null
  where type in ('income', 'transfer');

alter table transactions
  add constraint transactions_funding_source_expense
  check (type <> 'expense' or funding_source_id is not null);

alter table transactions
  add constraint transactions_funding_source_non_expense
  check (type = 'expense' or funding_source_id is null);
