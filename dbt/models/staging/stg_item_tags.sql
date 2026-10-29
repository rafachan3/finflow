-- Effective tags at line_key grain: line_key is the line's id for an
-- expense, and the transaction's id for income and transfers, which have no
-- lines. A line carries its own tags (tag_scope 'line') plus its
-- transaction's (tag_scope 'header').
select
    lt.transaction_item_id as line_key,
    i.transaction_id,
    tg.name as tag_name,
    'line' as tag_scope
from {{ source('ledger', 'transaction_item_tags') }} as lt
join {{ source('ledger', 'transaction_items') }} as i on i.id = lt.transaction_item_id
join {{ source('ledger', 'tags') }} as tg on tg.id = lt.tag_id

union all

select
    i.id as line_key,
    ht.transaction_id,
    tg.name as tag_name,
    'header' as tag_scope
from {{ source('ledger', 'transaction_tags') }} as ht
join {{ source('ledger', 'transaction_items') }} as i on i.transaction_id = ht.transaction_id
join {{ source('ledger', 'tags') }} as tg on tg.id = ht.tag_id

union all

select
    t.id as line_key,
    ht.transaction_id,
    tg.name as tag_name,
    'header' as tag_scope
from {{ source('ledger', 'transaction_tags') }} as ht
join {{ source('ledger', 'transactions') }} as t on t.id = ht.transaction_id
join {{ source('ledger', 'tags') }} as tg on tg.id = ht.tag_id
where t.type <> 'expense'
