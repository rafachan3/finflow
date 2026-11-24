-- The line note on the fixture (fixtures/synthetic.sql), worked out by hand:
-- the "Weekly shop" (a...06) has no header note and one note on its
-- Chocolate line (b...62). fct_transactions carries it on that line only,
-- with the header's null notes on both lines; fct_ledger_entry keeps the
-- header note. Tagged `fixture`.
{{ config(tags=['fixture']) }}

with expected (item_id, item_note) as (
    values
        ('b0000000-0000-0000-0000-000000000061'::uuid, null::text),
        ('b0000000-0000-0000-0000-000000000062'::uuid, 'for movie night')
)

select e.item_id
from expected as e
left join {{ ref('fct_transactions') }} as t on t.item_id = e.item_id
where t.item_note is distinct from e.item_note
   or t.notes is not null
union all
select transaction_id
from {{ ref('fct_ledger_entry') }}
where transaction_id = 'a0000000-0000-0000-0000-000000000006'
  and notes is not null
