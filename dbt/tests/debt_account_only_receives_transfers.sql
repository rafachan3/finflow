-- Migration 0017: a debt account only receives transfers. A transfer out of
-- one (a loan drawdown) is out of scope, and no income source deposits into
-- one, so savings_income only counts savings and investment accounts. A
-- CHECK cannot read accounts.kind, so this test is the guard. Returns ids
-- only.
select t.id::text as offender
from {{ source('ledger', 'transactions') }} as t
join {{ source('ledger', 'accounts') }} as a on a.id = t.from_account_id
where a.kind = 'debt'

union all

select 'income source ' || s.id::text
from {{ source('ledger', 'income_sources') }} as s
join {{ source('ledger', 'accounts') }} as a on a.id = s.deposit_account_id
where a.kind = 'debt'
