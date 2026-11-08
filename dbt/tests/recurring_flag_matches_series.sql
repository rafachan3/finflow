-- A transaction is flagged recurring exactly when it is linked to a series.
-- Migration 0020's CHECK enforces it; this test mirrors that CHECK, as
-- expense_funding_rules mirrors 0007's, so the nightly fails if a later
-- migration drops it.
select id as transaction_id
from {{ source('ledger', 'transactions') }}
where is_recurring <> (recurring_series_id is not null)
