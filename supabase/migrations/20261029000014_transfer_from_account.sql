-- Migration 0014: money moving out of savings and investment accounts.
-- Contract: docs/DATA_MODEL.md.
--
-- income_sources.deposit_account_id: the account income from that source
-- lands in (interest paid into a savings account); null means chequing.
--
-- transactions.from_account_id: the account a transfer leaves; null means
-- chequing. A transfer names at least one account and never the same one on
-- both sides, so a withdrawal is from set and to null. Rows saved before
-- this migration (to set, from null) stay valid.

alter table income_sources
  add column deposit_account_id smallint references accounts(id);

alter table transactions
  add column from_account_id smallint references accounts(id);

-- The unnamed initial-schema check `type <> 'transfer' or to_account_id is
-- not null` (Postgres named it transactions_check1).
alter table transactions
  drop constraint transactions_check1;

alter table transactions
  add constraint transactions_transfer_accounts
  check (
    type <> 'transfer'
    or (coalesce(from_account_id, to_account_id) is not null
        and from_account_id is distinct from to_account_id)
  );

alter table transactions
  add constraint transactions_from_account_transfer_only
  check (type = 'transfer' or from_account_id is null);
