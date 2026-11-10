-- Rolling N-month sums and share ratios (docs/SEMANTIC_LAYER.md,
-- "Planning marts"). One row per (month of the month list, N) for each
-- N in var window_months (default 3, 6 and 12). Money and ratios are null
-- unless every month of the window is complete and in the list.
-- fct_month_plan.*_pct_3m is N = 3, unchanged. The rows frames count
-- months, because fct_monthly_summary is zero-filled.
with months as (
    select *
    from {{ ref('fct_monthly_summary') }}
    where month_start >= date_trunc('month', '{{ var("ledger_start") }}'::date)
),

rolled as (
{%- for n in var('window_months') %}
    select
        month_start,
        {{ n }}::integer as window_months,
        count(*) filter (where is_complete_month) over w as complete_months_in_window,
        sum(spendable_income) over w as spendable_income_n,
        sum(needs_spend) over w as needs_spend_n,
        sum(wants_spend) over w as wants_spend_n,
        sum(financial_future) over w as financial_future_n,
        sum(unallocated_cash) over w as unallocated_cash_n,
        sum(spend) over w as spend_n,
        sum(income) over w as income_n
    from months
    window w as (
        order by month_start
        rows between {{ n - 1 }} preceding and current row
    )
    {%- if not loop.last %}
    union all
    {%- endif %}
{%- endfor %}
)

select
    month_start,
    window_months,
    complete_months_in_window::integer as complete_months_in_window,
    case when complete_months_in_window = window_months
        then spendable_income_n end::numeric(12, 2) as spendable_income,
    case when complete_months_in_window = window_months
        then needs_spend_n end::numeric(12, 2) as needs_spend,
    case when complete_months_in_window = window_months
        then wants_spend_n end::numeric(12, 2) as wants_spend,
    case when complete_months_in_window = window_months
        then financial_future_n end::numeric(12, 2) as financial_future,
    case when complete_months_in_window = window_months
        then unallocated_cash_n end::numeric(12, 2) as unallocated_cash,
    case when complete_months_in_window = window_months
        then spend_n end::numeric(12, 2) as spend,
    case when complete_months_in_window = window_months
        then income_n end::numeric(12, 2) as income,
    case when complete_months_in_window = window_months
        then round(needs_spend_n / nullif(spendable_income_n, 0), 4)
    end::numeric(9, 4) as needs_pct,
    case when complete_months_in_window = window_months
        then round(wants_spend_n / nullif(spendable_income_n, 0), 4)
    end::numeric(9, 4) as wants_pct,
    case when complete_months_in_window = window_months
        then round(financial_future_n / nullif(spendable_income_n, 0), 4)
    end::numeric(9, 4) as financial_future_pct,
    case when complete_months_in_window = window_months
        then round(unallocated_cash_n / nullif(spendable_income_n, 0), 4)
    end::numeric(9, 4) as unallocated_pct,
    case when complete_months_in_window = window_months
        then round((income_n - spend_n) / nullif(income_n, 0), 4)
    end::numeric(9, 4) as unspent_rate
from rolled
