-- One row per (month of the month list, account), zero-filled
-- (docs/SEMANTIC_LAYER.md, "Account marts"). Deposits are chequing to
-- the account, withdrawals the reverse, moves are between two named
-- accounts, savings_income is interest that lands here. Balance is the
-- opening plus flows after as_of through month end; null without an
-- opening, and never for investment or debt.
with months as (
    select month_start
    from {{ ref('fct_month_plan') }}
),

accts as (
    select id as account_id, name as account_name, kind as account_kind
    from {{ source('ledger', 'accounts') }}
),

opening as (
    select account_id, as_of, amount
    from {{ source('ledger', 'account_opening_balances') }}
),

flows as (
    select
        t.occurred_on,
        t.month_start,
        t.to_account_id as account_id,
        t.amount as deposits,
        0::numeric(12, 2) as withdrawals,
        0::numeric(12, 2) as moves_in,
        0::numeric(12, 2) as moves_out,
        0::numeric(12, 2) as savings_income
    from {{ ref('stg_transactions') }} as t
    where t.type = 'transfer'
      and t.from_account_id is null
      and t.to_account_id is not null

    union all

    select
        t.occurred_on,
        t.month_start,
        t.from_account_id,
        0,
        t.amount,
        0,
        0,
        0
    from {{ ref('stg_transactions') }} as t
    where t.type = 'transfer'
      and t.from_account_id is not null
      and t.to_account_id is null

    union all

    select
        t.occurred_on,
        t.month_start,
        t.to_account_id,
        0,
        0,
        t.amount,
        0,
        0
    from {{ ref('stg_transactions') }} as t
    where t.type = 'transfer'
      and t.from_account_id is not null
      and t.to_account_id is not null

    union all

    select
        t.occurred_on,
        t.month_start,
        t.from_account_id,
        0,
        0,
        0,
        t.amount,
        0
    from {{ ref('stg_transactions') }} as t
    where t.type = 'transfer'
      and t.from_account_id is not null
      and t.to_account_id is not null

    union all

    select
        t.occurred_on,
        t.month_start,
        t.deposit_account_id,
        0,
        0,
        0,
        0,
        t.amount
    from {{ ref('stg_transactions') }} as t
    where t.type = 'income'
      and t.deposit_account_id is not null
),

monthly as (
    select
        month_start,
        account_id,
        sum(deposits)::numeric(12, 2) as deposits,
        sum(withdrawals)::numeric(12, 2) as withdrawals,
        sum(moves_in)::numeric(12, 2) as moves_in,
        sum(moves_out)::numeric(12, 2) as moves_out,
        sum(savings_income)::numeric(12, 2) as savings_income
    from flows
    group by 1, 2
),

grid as (
    select
        m.month_start,
        a.account_id,
        a.account_name,
        a.account_kind,
        coalesce(s.deposits, 0)::numeric(12, 2) as deposits,
        coalesce(s.withdrawals, 0)::numeric(12, 2) as withdrawals,
        coalesce(s.moves_in, 0)::numeric(12, 2) as moves_in,
        coalesce(s.moves_out, 0)::numeric(12, 2) as moves_out,
        coalesce(s.savings_income, 0)::numeric(12, 2) as savings_income
    from months as m
    cross join accts as a
    left join monthly as s
        on s.month_start = m.month_start
       and s.account_id = a.account_id
),

with_cum as (
    select
        *,
        (deposits + moves_in + savings_income - withdrawals - moves_out)
            ::numeric(12, 2) as net_flow,
        sum(deposits + moves_in + savings_income - withdrawals - moves_out)
            over (partition by account_id order by month_start)
            ::numeric(12, 2) as net_flow_cumulative
    from grid
),

month_end as (
    select
        c.*,
        (c.month_start + interval '1 month' - interval '1 day')::date as month_end,
        o.as_of,
        o.amount as opening_amount
    from with_cum as c
    left join opening as o on o.account_id = c.account_id
)

select
    e.month_start,
    e.account_name,
    e.account_kind,
    e.deposits,
    e.withdrawals,
    e.moves_in,
    e.moves_out,
    e.savings_income,
    e.net_flow,
    e.net_flow_cumulative,
    case
        when e.account_kind is distinct from 'savings' then null
        when e.opening_amount is null then null
        when e.month_end < e.as_of then null
        else (
            e.opening_amount + coalesce((
                select sum(
                    f.deposits + f.moves_in + f.savings_income
                    - f.withdrawals - f.moves_out
                )
                from flows as f
                where f.account_id = e.account_id
                  and f.occurred_on > e.as_of
                  and f.occurred_on <= e.month_end
            ), 0)
        )::numeric(12, 2)
    end as balance
from month_end as e
