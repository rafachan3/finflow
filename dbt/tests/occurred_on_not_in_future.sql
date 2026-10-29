-- A date past Toronto's tomorrow is most likely a typo from Fix date.
{{ config(severity='warn') }}
select transaction_id
from {{ ref('stg_transactions') }}
where occurred_on > {{ toronto_today() }} + 1
