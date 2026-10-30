-- Migration 0014: a transfer names the account it leaves, the one it
-- enters, or both (the side left null is chequing), never the same account
-- twice, and only a transfer has a from account. Each account it names
-- resolves to a name and a kind, so a staging join that dropped one fails.
select transaction_id
from {{ ref('stg_transactions') }}
where (type = 'transfer'
       and (coalesce(from_account_id, to_account_id) is null
            or from_account_id = to_account_id
            or (from_account_id is not null and (from_account_name is null or from_account_kind is null))
            or (to_account_id is not null and (to_account_name is null or account_kind is null))))
   or (type <> 'transfer' and from_account_id is not null)
