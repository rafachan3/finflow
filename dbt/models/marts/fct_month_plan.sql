-- One row per month of the month list (docs/SEMANTIC_LAYER.md, "Planning
-- marts"): fct_monthly_summary's months from the ledger start's month on,
-- so a stray row dated earlier adds no month. A complete month plans from
-- its actual spendable_income; the current month from the expected income,
-- the greater of income so far and the baseline. The rows frames count
-- months, because fct_monthly_summary is zero-filled.
with months as (
    select *
    from {{ ref('fct_monthly_summary') }}
    where month_start >= date_trunc('month', '{{ var("ledger_start") }}'::date)
),

windowed as (
    select
        month_start,
        is_complete_month,
        spendable_income,
        needs_target_pct,
        wants_target_pct,
        financial_future_target_pct,
        extract(day from month_start + interval '1 month' - interval '1 day')::integer
            as days_in_month,
        count(*) filter (where is_complete_month) over baseline as baseline_months,
        round(avg(spendable_income) filter (where is_complete_month) over baseline, 2)
            ::numeric(12, 2) as spendable_income_baseline,
        count(*) filter (where is_complete_month) over rolling as rolling_complete,
        sum(spendable_income) over rolling as spendable_income_3m,
        sum(needs_spend) over rolling as needs_spend_3m,
        sum(wants_spend) over rolling as wants_spend_3m,
        sum(financial_future) over rolling as financial_future_3m,
        sum(unallocated_cash) over rolling as unallocated_cash_3m
    from months
    window
        baseline as (order by month_start rows between 3 preceding and 1 preceding),
        rolling as (order by month_start rows between 2 preceding and current row)
),

expected as (
    select
        *,
        -- Written out: greatest() ignores a null baseline and would plan
        -- the current month from income so far.
        case
            when is_complete_month then spendable_income
            when baseline_months > 0 then greatest(spendable_income, spendable_income_baseline)
        end::numeric(12, 2) as spendable_income_expected
    from windowed
)

select
    month_start,
    is_complete_month,
    days_in_month,
    case
        when is_complete_month then days_in_month
        when month_start = date_trunc('month', {{ toronto_today() }})::date
            then extract(day from {{ toronto_today() }})::integer
        else 0
    end as as_of_day,
    spendable_income,
    baseline_months::integer as baseline_months,
    spendable_income_baseline,
    spendable_income_expected,
    round(spendable_income / nullif(spendable_income_expected, 0), 4)::numeric(9, 4)
        as income_received_share,
    round(needs_target_pct * spendable_income_expected, 2)::numeric(12, 2) as needs_plan,
    round(wants_target_pct * spendable_income_expected, 2)::numeric(12, 2) as wants_plan,
    round(financial_future_target_pct * spendable_income_expected, 2)::numeric(12, 2)
        as financial_future_plan,
    case when rolling_complete = 3
        then round(needs_spend_3m / nullif(spendable_income_3m, 0), 4)
    end::numeric(9, 4) as needs_pct_3m,
    case when rolling_complete = 3
        then round(wants_spend_3m / nullif(spendable_income_3m, 0), 4)
    end::numeric(9, 4) as wants_pct_3m,
    case when rolling_complete = 3
        then round(financial_future_3m / nullif(spendable_income_3m, 0), 4)
    end::numeric(9, 4) as financial_future_pct_3m,
    case when rolling_complete = 3
        then round(unallocated_cash_3m / nullif(spendable_income_3m, 0), 4)
    end::numeric(9, 4) as unallocated_pct_3m
from expected
