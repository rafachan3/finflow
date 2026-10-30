-- One row per month, one column per metric in docs/SEMANTIC_LAYER.md, named
-- exactly as there. Months run from the first data month to the current
-- Toronto month (or a later month a row is already dated in), zero-filled
-- through dim_date so the running balance carries over an empty month.
-- monthly_summary_matches_hand_written_sql recomputes every month from
-- public with the contract's reference SQL.
with months as (
    select distinct month_start
    from {{ ref('dim_date') }}
    where date_day <= (
        select greatest(max(occurred_on), {{ toronto_today() }})
        from {{ ref('fct_transactions') }}
    )
),

monthly as (
    select
        m.month_start,
        coalesce(sum(f.amount) filter (where f.type = 'income'), 0) as income,
        coalesce(sum(f.amount) filter (where f.type = 'expense' and f.is_self_funded), 0) as spend,
        coalesce(sum(f.amount) filter (
            where f.type = 'expense' and f.is_self_funded and f.bucket = 'needs'), 0) as needs_spend,
        coalesce(sum(f.amount) filter (
            where f.type = 'expense' and f.is_self_funded and f.bucket = 'wants'), 0) as wants_spend,
        coalesce(sum(f.amount) filter (
            where f.type = 'expense' and f.is_self_funded and f.bucket = 'needs'
              and f.is_recurring), 0) as fixed_base_burn,
        coalesce(sum(f.amount) filter (
            where f.type = 'expense' and f.is_self_funded and f.bucket = 'needs'
              and not f.is_recurring), 0) as variable_needs,
        coalesce(sum(f.amount) filter (
            where f.type = 'expense' and not f.is_self_funded), 0) as external_spend,
        coalesce(sum(f.amount) filter (
            where f.type = 'transfer' and f.account_kind in ('savings', 'investment')), 0) as transfers,
        count(distinct f.transaction_id) as transaction_count
    from months as m
    left join {{ ref('fct_transactions') }} as f on f.month_start = m.month_start
    group by m.month_start
)

select
    month_start,
    income::numeric(12, 2) as income,
    spend::numeric(12, 2) as spend,
    needs_spend::numeric(12, 2) as needs_spend,
    wants_spend::numeric(12, 2) as wants_spend,
    fixed_base_burn::numeric(12, 2) as fixed_base_burn,
    variable_needs::numeric(12, 2) as variable_needs,
    external_spend::numeric(12, 2) as external_spend,
    transfers::numeric(12, 2) as transfers,
    round((income - spend) / nullif(income, 0), 4)::numeric(9, 4) as savings_rate,
    (income - spend - transfers)::numeric(12, 2) as unallocated_cash,
    sum(income - spend - transfers) over (order by month_start)::numeric(12, 2)
        as unallocated_cash_cumulative,
    round(needs_spend / nullif(wants_spend, 0), 4)::numeric(9, 4) as needs_wants_ratio,
    transaction_count::integer as transaction_count,
    month_start < date_trunc('month', {{ toronto_today() }})::date as is_complete_month
from monthly
