-- fct_ledger_entry's header amounts match the monthly metrics, and each
-- expense's needs_amount + wants_amount equals its header (lines sum to
-- the header, and every line is needs or wants). Returns months or ids,
-- never amounts. The nightly checks production.
with by_month as (
    select
        month_start,
        coalesce(sum(amount) filter (where type = 'income'), 0)
            as income,
        coalesce(sum(amount) filter (where type = 'expense' and is_self_funded), 0)
            as spend,
        coalesce(sum(amount) filter (where type = 'expense' and not is_self_funded), 0)
            as external_spend
    from {{ ref('fct_ledger_entry') }}
    group by 1
)

select s.month_start::text as id
from {{ ref('fct_monthly_summary') }} as s
left join by_month as e using (month_start)
where s.income is distinct from coalesce(e.income, 0)
   or s.spend is distinct from coalesce(e.spend, 0)
   or s.external_spend is distinct from coalesce(e.external_spend, 0)

union all

select e.month_start::text
from by_month as e
left join {{ ref('fct_monthly_summary') }} as s using (month_start)
where s.month_start is null

union all

select transaction_id::text
from {{ ref('fct_ledger_entry') }}
where type = 'expense'
  and needs_amount + wants_amount <> amount
