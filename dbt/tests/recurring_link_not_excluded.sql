-- Migration 0016: a transaction is never both linked to a series and
-- excluded from it ("not this series"). The bot will link and exclude in one
-- database transaction that removes the opposite row; this catches any
-- writer that does not. Returns ids only.
select e.series_id, e.transaction_id
from {{ source('ledger', 'recurring_exclusions') }} as e
join {{ source('ledger', 'transactions') }} as t
    on t.id = e.transaction_id and t.recurring_series_id = e.series_id
