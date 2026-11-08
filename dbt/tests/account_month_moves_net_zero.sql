-- A move between two accounts is in no metric: per month, moves_in
-- equal moves_out. Returns months that do not net to 0. The nightly
-- checks production.
select month_start
from {{ ref('fct_account_month') }}
group by 1
having sum(moves_in) is distinct from sum(moves_out)
