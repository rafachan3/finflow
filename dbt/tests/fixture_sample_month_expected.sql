-- The fixture's sample month, 2026-06, against values worked out by hand
-- from fixtures/synthetic.sql. This catches a misreading of the contract
-- that the mart and the reference SQL share. Tagged `fixture`: it only
-- means something on the synthetic ledger, never on production.
--
-- income         3000.00 salary + 25.00 refund                         = 3025.00
-- spend          own lines: rent 1200.00, streaming 15.99, receipt
--                30.25 + 9.75 + 7.50, lunch 12.40 (06-30); the 80.00
--                dinner was paid by family                              = 1275.89
-- needs_spend    1200.00 + 30.25 + 7.50                                 = 1237.75
-- wants_spend    15.99 + 9.75 + 12.40                                   =   38.14
-- fixed_base_burn  rent, the one recurring needs line                   = 1200.00
-- variable_needs   30.25 + 7.50                                         =   37.75
-- external_spend   the dinner                                           =   80.00
-- transfers        500.00 savings + 300.00 investment                   =  800.00
-- savings_rate     (3025.00 - 1275.89) / 3025.00 = 0.57821...           =   0.5782
-- unallocated_cash 3025.00 - 1275.89 - 800.00                           =  949.11
-- unallocated_cash_cumulative  June is the first month                  =  949.11
-- needs_wants_ratio  1237.75 / 38.14 = 32.45280...                      =  32.4528
-- transaction_count  a...01 to a...09                                   =        9
{{ config(tags=['fixture']) }}

with expected (metric, value) as (
    values
        ('income', 3025.00),
        ('spend', 1275.89),
        ('needs_spend', 1237.75),
        ('wants_spend', 38.14),
        ('fixed_base_burn', 1200.00),
        ('variable_needs', 37.75),
        ('external_spend', 80.00),
        ('transfers', 800.00),
        ('savings_rate', 0.5782),
        ('unallocated_cash', 949.11),
        ('unallocated_cash_cumulative', 949.11),
        ('needs_wants_ratio', 32.4528),
        ('transaction_count', 9),
        ('is_complete_month', 1)
),

actual (metric, value) as (
    select v.metric, v.value
    from {{ ref('fct_monthly_summary') }} as s
    cross join lateral (values
        ('income', s.income),
        ('spend', s.spend),
        ('needs_spend', s.needs_spend),
        ('wants_spend', s.wants_spend),
        ('fixed_base_burn', s.fixed_base_burn),
        ('variable_needs', s.variable_needs),
        ('external_spend', s.external_spend),
        ('transfers', s.transfers),
        ('savings_rate', s.savings_rate),
        ('unallocated_cash', s.unallocated_cash),
        ('unallocated_cash_cumulative', s.unallocated_cash_cumulative),
        ('needs_wants_ratio', s.needs_wants_ratio),
        ('transaction_count', s.transaction_count::numeric),
        ('is_complete_month', s.is_complete_month::integer::numeric)
    ) as v (metric, value)
    where s.month_start = date '2026-06-01'
)

select coalesce(e.metric, a.metric) as metric, e.value as expected, a.value as actual
from expected as e
full join actual as a on a.metric = e.metric
where e.value is distinct from a.value
