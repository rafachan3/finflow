-- An expense has a funder ('self' unless someone else paid); income and
-- transfers have none.
select transaction_id
from {{ ref('stg_transactions') }}
where (type = 'expense') <> (funding_source_name is not null)
