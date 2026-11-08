-- Balance is never computed for investment (contributed-since-tracking)
-- or debt (a debt account has no balance). Returns those rows. The
-- nightly checks production.
select month_start, account_name, account_kind
from {{ ref('fct_account_month') }}
where account_kind is distinct from 'savings'
  and balance is not null
