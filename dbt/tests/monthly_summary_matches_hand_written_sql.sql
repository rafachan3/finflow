-- The acceptance check: every metric of every month in fct_monthly_summary
-- equals docs/SEMANTIC_LAYER.md's reference SQL, run here straight over the
-- public tables (no staging, no fct). The `ledger` and `monthly` CTEs are
-- that query as written; keep them in step with the contract. A month in
-- one side only fails too. Returns month and metric names, never values,
-- because the nightly log is public.
with ledger as (
    -- expense lines
    select date_trunc('month', t.occurred_on)::date as month_start,
           'expense' as type, i.amount, i.bucket::text as bucket,
           t.is_recurring, f.name = 'self' as is_self_funded,
           null::boolean as from_chequing, null::boolean as to_chequing
    from {{ source('ledger', 'transactions') }} t
    join {{ source('ledger', 'transaction_items') }} i on i.transaction_id = t.id
    join {{ source('ledger', 'funding_sources') }} f   on f.id = t.funding_source_id
    where t.type = 'expense'
    union all
    -- income and transfer headers; a null account is chequing
    select date_trunc('month', t.occurred_on)::date, t.type::text, t.amount,
           null, t.is_recurring, null,
           t.from_account_id is null,
           case when t.type = 'income' then s.deposit_account_id
                else t.to_account_id end is null
    from {{ source('ledger', 'transactions') }} t
    left join {{ source('ledger', 'income_sources') }} s on s.id = t.income_source_id
    where t.type <> 'expense'
), monthly as (
  select month_start,
    coalesce(sum(amount) filter (where type = 'income'), 0) as income,
    coalesce(sum(amount) filter (where type = 'income' and not to_chequing), 0) as savings_income,
    coalesce(sum(amount) filter (where type = 'expense' and is_self_funded), 0) as spend,
    coalesce(sum(amount) filter (where type = 'expense' and is_self_funded
                                   and bucket = 'needs'), 0) as needs_spend,
    coalesce(sum(amount) filter (where type = 'expense' and is_self_funded
                                   and bucket = 'wants'), 0) as wants_spend,
    coalesce(sum(amount) filter (where type = 'expense' and is_self_funded
                                   and bucket = 'needs' and is_recurring), 0) as fixed_base_burn,
    coalesce(sum(amount) filter (where type = 'expense' and is_self_funded
                                   and bucket = 'needs' and not is_recurring), 0) as variable_needs,
    coalesce(sum(amount) filter (where type = 'expense' and not is_self_funded), 0) as external_spend,
    coalesce(sum(amount) filter (where type = 'transfer'
                                   and from_chequing and not to_chequing), 0) as transfers,
    coalesce(sum(amount) filter (where type = 'transfer'
                                   and not from_chequing and to_chequing), 0) as withdrawals
  from ledger
  group by month_start
),

-- The contract's month list, built here without dim_date: first data month
-- to the current Toronto month or the last month with data. A month with no
-- rows is 0 for money, null for ratios, and carries the balance forward.
months as (
    select generate_series(
        coalesce(min(month_start), date_trunc('month', {{ toronto_today() }})::date),
        greatest(max(month_start), date_trunc('month', {{ toronto_today() }})::date),
        interval '1 month'
    )::date as month_start
    from monthly
),

expected as (
    select
        s.month_start,
        coalesce(m.income, 0) as income,
        coalesce(m.savings_income, 0) as savings_income,
        coalesce(m.spend, 0) as spend,
        coalesce(m.needs_spend, 0) as needs_spend,
        coalesce(m.wants_spend, 0) as wants_spend,
        coalesce(m.fixed_base_burn, 0) as fixed_base_burn,
        coalesce(m.variable_needs, 0) as variable_needs,
        coalesce(m.external_spend, 0) as external_spend,
        coalesce(m.transfers, 0) as transfers,
        coalesce(m.withdrawals, 0) as withdrawals,
        round((m.income - m.spend) / nullif(m.income, 0), 4) as savings_rate,
        coalesce(m.income - m.savings_income - m.spend - m.transfers + m.withdrawals, 0)
            as unallocated_cash,
        sum(coalesce(m.income - m.savings_income - m.spend - m.transfers + m.withdrawals, 0))
            over (order by s.month_start) as unallocated_cash_cumulative,
        round(m.needs_spend / nullif(m.wants_spend, 0), 4) as needs_wants_ratio
    from months as s
    left join monthly as m on m.month_start = s.month_start
),

actual as (
    select * from {{ ref('fct_monthly_summary') }}
),

compared as (
    select
        coalesce(e.month_start, a.month_start) as month_start,
        e.month_start is null or a.month_start is null as month_mismatch,
        array_remove(array[
            case when e.income is distinct from a.income then 'income' end,
            case when e.savings_income is distinct from a.savings_income then 'savings_income' end,
            case when e.spend is distinct from a.spend then 'spend' end,
            case when e.needs_spend is distinct from a.needs_spend then 'needs_spend' end,
            case when e.wants_spend is distinct from a.wants_spend then 'wants_spend' end,
            case when e.fixed_base_burn is distinct from a.fixed_base_burn then 'fixed_base_burn' end,
            case when e.variable_needs is distinct from a.variable_needs then 'variable_needs' end,
            case when e.external_spend is distinct from a.external_spend then 'external_spend' end,
            case when e.transfers is distinct from a.transfers then 'transfers' end,
            case when e.withdrawals is distinct from a.withdrawals then 'withdrawals' end,
            case when e.savings_rate is distinct from a.savings_rate then 'savings_rate' end,
            case when e.unallocated_cash is distinct from a.unallocated_cash then 'unallocated_cash' end,
            case when e.unallocated_cash_cumulative is distinct from a.unallocated_cash_cumulative
                then 'unallocated_cash_cumulative' end,
            case when e.needs_wants_ratio is distinct from a.needs_wants_ratio
                then 'needs_wants_ratio' end
        ], null) as metrics
    from expected as e
    full join actual as a on a.month_start = e.month_start
)

select month_start, month_mismatch, metrics
from compared
where month_mismatch or cardinality(metrics) > 0
