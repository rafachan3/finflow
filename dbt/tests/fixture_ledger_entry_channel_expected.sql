-- The purchase channel on the fixture (fixtures/synthetic.sql), worked out
-- by hand: the "Late lunch" (a...07) went through DoorDash, a Fast Food
-- venue with no merchant; the "Weekly shop" (a...06) is Acme Mart ·
-- Supermarket bought directly, so no channel; the August "Dinners out"
-- (a...17) is Acme Mart through Uber Eats with no venue; the rent has none
-- of the three. fct_transactions carries the same channel. Tagged `fixture`.
{{ config(tags=['fixture']) }}

with expected (transaction_id, channel_name, counterparty) as (
    values
        ('a0000000-0000-0000-0000-000000000007'::uuid, 'DoorDash', 'Fast Food · DoorDash'),
        ('a0000000-0000-0000-0000-000000000006'::uuid, null, 'Acme Mart · Supermarket'),
        ('a0000000-0000-0000-0000-000000000017'::uuid, 'Uber Eats', 'Acme Mart · Uber Eats'),
        ('a0000000-0000-0000-0000-000000000003'::uuid, null, null)
)

select e.transaction_id
from expected as e
left join {{ ref('fct_ledger_entry') }} as l on l.transaction_id = e.transaction_id
where l.channel_name is distinct from e.channel_name
   or l.counterparty is distinct from e.counterparty
   or exists (
       select 1
       from {{ ref('fct_transactions') }} as t
       where t.transaction_id = e.transaction_id
         and t.channel_name is distinct from e.channel_name
   )
