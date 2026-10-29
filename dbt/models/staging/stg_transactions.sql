-- One row per transaction header, with its lookups named and where it came
-- from. entry_source is the source of the confirmed ingestion (the earliest,
-- if there were ever two; a warn test watches for that), else 'import'.
with confirmed as (
    select distinct on (transaction_id) transaction_id, source
    from {{ source('ledger', 'ingestions') }}
    where status = 'confirmed' and transaction_id is not null
    order by transaction_id, created_at
)

select
    t.id as transaction_id,
    t.occurred_on,
    date_trunc('month', t.occurred_on)::date as month_start,
    t.type::text as type,
    t.amount,
    t.currency::text as currency,
    t.description,
    t.notes,
    t.is_recurring,
    f.name as funding_source_name,
    m.name as merchant_name,
    v.name as venue_name,
    s.name as income_source_name,
    a.name as to_account_name,
    a.kind as account_kind,
    coalesce(c.source, 'import') as entry_source,
    t.created_at
from {{ source('ledger', 'transactions') }} as t
left join {{ source('ledger', 'funding_sources') }} as f on f.id = t.funding_source_id
left join {{ source('ledger', 'merchants') }} as m on m.id = t.merchant_id
left join {{ source('ledger', 'venues') }} as v on v.id = t.venue_id
left join {{ source('ledger', 'income_sources') }} as s on s.id = t.income_source_id
left join {{ source('ledger', 'accounts') }} as a on a.id = t.to_account_id
left join confirmed as c on c.transaction_id = t.id
