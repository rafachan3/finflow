-- Migration 0021: pairs the owner has ruled are not duplicates.
-- Contract: docs/DATA_MODEL.md; how to add one: docs/TESTING.md ("The
-- nightly dbt build").
--
-- The nightly ledger-health tests report pairs of transactions that look
-- like one payment logged twice. Two tickets or two laundry machines at one
-- price are real, so the owner acknowledges such a pair here and the tests
-- stop listing it. The pairs live in the database, never in the public repo.
--
-- One row per unordered pair: the smaller id is always first_id, so a pair
-- can be stored once only. Deleting either transaction deletes the row.
--
-- Grants: the default privileges of 0003 and 0013 make it readable by
-- finflow_readonly and finflow_dbt; nothing for finflow_analyst (it reads
-- marts only) or the Data API roles (0015).

create table duplicate_acknowledgements (
  first_id        uuid        not null references transactions(id) on delete cascade,
  second_id       uuid        not null references transactions(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (first_id, second_id),
  check (first_id < second_id)
);
