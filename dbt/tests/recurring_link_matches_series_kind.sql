-- Migration 0016: a transaction linked to a recurring series has its
-- series' kind, so a salary never sits in an expense series. The composite
-- FK (recurring_series_id, type) -> recurring_series (id, kind) makes a
-- mismatch impossible; the first branch would catch a mismatch or a link to
-- a missing series if the FK were ever dropped, and the second fails while it
-- is missing. Returns ids only.
select t.id::text as transaction_id
from {{ source('ledger', 'transactions') }} as t
left join {{ source('ledger', 'recurring_series') }} as s on s.id = t.recurring_series_id
where t.recurring_series_id is not null
  and (s.id is null or s.kind <> t.type)

union all

select 'missing: transactions_recurring_series_fkey'
where not exists (
    select 1 from pg_constraint
    where conname = 'transactions_recurring_series_fkey'
      and conrelid = 'public.transactions'::regclass
      and confrelid = 'public.recurring_series'::regclass
      and contype = 'f'
      and cardinality(conkey) = 2
)
