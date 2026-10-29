-- Every transfer names the savings or investment account it went to.
select transaction_id
from {{ ref('stg_transactions') }}
where type = 'transfer'
  and (to_account_name is null or account_kind is null)
