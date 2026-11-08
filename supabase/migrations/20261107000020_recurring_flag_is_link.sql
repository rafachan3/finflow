-- is_recurring is exactly the series link. Migration 0016 made linking and
-- unlinking set the flag but let an unlinked INSERT keep the flag it was
-- given, so the owner's backfill could review legacy flags. That list is
-- empty now (checked read-only before this shipped: no row flagged without a
-- series, none linked without the flag), so the flag becomes an invariant.
--
-- 0016's trigger stays: updates still derive the flag from the link, and a
-- linked INSERT is still marked recurring. What changes is that an unlinked
-- INSERT with is_recurring = true is now refused instead of kept.
alter table transactions
  add constraint transactions_recurring_flag_is_link
  check (is_recurring = (recurring_series_id is not null));
