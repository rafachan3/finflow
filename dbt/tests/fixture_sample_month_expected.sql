-- The fixture's sample month, 2026-06, against values worked out by hand
-- from fixtures/synthetic.sql. This catches a misreading of the contract
-- that the mart and the reference SQL share. Tagged `fixture`: it only
-- means something on the synthetic ledger, never on production.
--
-- income         3000.00 salary + 25.00 refund + 4.12 interest         = 3029.12
-- savings_income   the interest, whose source lands in savings          =    4.12
-- spend          own lines: rent 1200.00, streaming 15.99, receipt
--                30.25 + 9.75 + 7.50, lunch 12.40 (06-30); the 80.00
--                dinner was paid by family                              = 1275.89
-- needs_spend    1200.00 + 30.25 + 7.50                                 = 1237.75
-- wants_spend    15.99 + 9.75 + 12.40                                   =   38.14
-- fixed_base_burn  rent, the one recurring needs line                   = 1200.00
-- variable_needs   30.25 + 7.50                                         =   37.75
-- external_spend   the dinner                                           =   80.00
-- transfers        out of chequing: 500.00 savings + 300.00 investment;
--                  the 200.00 savings-to-investment move is not one     =  800.00
-- withdrawals      150.00 out of savings into chequing                  =  150.00
-- unspent_rate     (3029.12 - 1275.89) / 3029.12 = 0.57879...           =   0.5788
-- unallocated_cash 3029.12 - 4.12 - 1275.89 - 800.00 + 150.00           = 1099.11
-- unallocated_cash_cumulative  June is the first month                  = 1099.11
-- needs_wants_ratio  1237.75 / 38.14 = 32.45280...                      =  32.4528
-- transaction_count  a...01 to a...09, a...13 to a...15                 =       12
{{ config(tags=['fixture']) }}

with expected (metric, value) as (
    values
        ('income', 3029.12),
        ('savings_income', 4.12),
        ('spend', 1275.89),
        ('needs_spend', 1237.75),
        ('wants_spend', 38.14),
        ('fixed_base_burn', 1200.00),
        ('variable_needs', 37.75),
        ('external_spend', 80.00),
        ('transfers', 800.00),
        ('withdrawals', 150.00),
        ('unspent_rate', 0.5788),
        ('unallocated_cash', 1099.11),
        ('unallocated_cash_cumulative', 1099.11),
        ('needs_wants_ratio', 32.4528),
        ('transaction_count', 12),
        ('is_complete_month', 1)
),

actual (metric, value) as (
    select v.metric, v.value
    from {{ ref('fct_monthly_summary') }} as s
    cross join lateral (values
        ('income', s.income),
        ('savings_income', s.savings_income),
        ('spend', s.spend),
        ('needs_spend', s.needs_spend),
        ('wants_spend', s.wants_spend),
        ('fixed_base_burn', s.fixed_base_burn),
        ('variable_needs', s.variable_needs),
        ('external_spend', s.external_spend),
        ('transfers', s.transfers),
        ('withdrawals', s.withdrawals),
        ('unspent_rate', s.unspent_rate),
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
