-- is_support is the flag of an income source: set on every income row,
-- null on expenses and transfers.
select line_key
from {{ ref('fct_transactions') }}
where (type = 'income') <> (is_support is not null)
