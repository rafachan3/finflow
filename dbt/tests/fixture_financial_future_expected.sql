-- The 50/30/20 view of the fixture months against values worked out by hand
-- from fixtures/synthetic.sql, with migration 0018's seeded 50/30/20
-- targets. Like fixture_sample_month_expected, this catches a misreading of
-- the contract that the mart and the reference SQL share. Tagged `fixture`.
--
-- Every month: needs_target_pct 0.5000, wants_target_pct 0.3000,
-- financial_future_target_pct 0.2000.
--
-- 2026-08, the worked example: income 3000.00 salary, no savings interest.
--   spendable_income   3000.00 - 0                                 = 3000.00
--   financial_future   300.00 savings + 200.00 investment - 0      =  500.00
--   target             0.2 * 3000.00                               =  600.00
--   gap                600.00 - 500.00: move 100 of the 400 left   =  100.00
--   needs_pct          1400.00 / 3000.00 = 0.46666...              =  0.4667
--   wants_pct           700.00 / 3000.00 = 0.23333...              =  0.2333
--   financial_future_pct 500.00 / 3000.00 = 0.16666...             =  0.1667
--   unallocated_pct     400.00 / 3000.00 = 0.13333...              =  0.1333
--     (unallocated_cash 3000.00 - 2100.00 - 500.00 = 400.00)
--
-- 2026-09, a loan: income 2000.00; spend 60.00 electricity + 250.00 car
-- loan minimum payment (needs) = 310.00; the 150.00 extra payment is a
-- deposit into the debt account; the 100.00 paid on the loan from savings
-- is a move between two accounts, in no metric.
--   spendable_income                                               = 2000.00
--   financial_future   150.00 - 0                                  =  150.00
--   target             0.2 * 2000.00                               =  400.00
--   gap                400.00 - 150.00                             =  250.00
--   needs_pct          310.00 / 2000.00                            =  0.1550
--   wants_pct          0 / 2000.00                                 =  0.0000
--   financial_future_pct 150.00 / 2000.00                          =  0.0750
--   unallocated_pct    (2000.00 - 310.00 - 150.00) / 2000.00
--                      = 1540.00 / 2000.00                         =  0.7700
--
-- 2026-06, savings interest and a withdrawal: income 3029.12 includes the
-- 4.12 interest paid into savings, which is not spendable.
--   spendable_income   3029.12 - 4.12                              = 3025.00
--   financial_future   800.00 transfers - 150.00 withdrawal        =  650.00
--   target             0.2 * 3025.00                               =  605.00
--   gap                605.00 - 650.00: ahead of target            =  -45.00
--   needs_pct          1237.75 / 3025.00 = 0.409173...             =  0.4092
--   wants_pct            38.14 / 3025.00 = 0.012608...             =  0.0126
--   financial_future_pct 650.00 / 3025.00 = 0.214876...            =  0.2149
--   unallocated_pct    1099.11 / 3025.00 = 0.363342...             =  0.3633
--
-- 2026-07, spend and no income: spendable_income 0.00, so every *_pct is
-- null; financial_future 0.00, target 0.00, gap 0.00.
-- 2026-10, no rows at all: the same, from the zero-filled month.
--
-- 2026-05, income, savings interest and spend, nothing moved: income
-- 1002.50 includes 2.50 interest paid into savings; spend 600.00 needs +
-- 400.00 wants.
--   spendable_income   1002.50 - 2.50                              = 1000.00
--   financial_future   no transfers, no withdrawals                =    0.00
--   target             0.2 * 1000.00                               =  200.00
--   gap                200.00 - 0                                  =  200.00
--   needs_pct          600.00 / 1000.00                            =  0.6000
--   wants_pct          400.00 / 1000.00                            =  0.4000
--   financial_future_pct 0 / 1000.00                               =  0.0000
--   unallocated_pct    (1000.00 - 1000.00 - 0) / 1000.00           =  0.0000
--
-- 2026-03, only an 80.00 withdrawal, no income: spendable_income 0.00, so
-- every *_pct is null; financial_future 0 - 80.00 = -80.00, target 0.00,
-- gap 0.00 - (-80.00) = 80.00.
-- 2026-04, only an 80.00 transfer, no income: financial_future 80.00,
-- target 0.00, gap -80.00, every *_pct null.
{{ config(tags=['fixture']) }}

with expected (month_start, metric, value) as (
    values
        (date '2026-08-01', 'spendable_income', 3000.00),
        (date '2026-08-01', 'financial_future', 500.00),
        (date '2026-08-01', 'financial_future_target', 600.00),
        (date '2026-08-01', 'financial_future_gap', 100.00),
        (date '2026-08-01', 'needs_pct', 0.4667),
        (date '2026-08-01', 'wants_pct', 0.2333),
        (date '2026-08-01', 'financial_future_pct', 0.1667),
        (date '2026-08-01', 'unallocated_pct', 0.1333),

        (date '2026-09-01', 'spendable_income', 2000.00),
        (date '2026-09-01', 'financial_future', 150.00),
        (date '2026-09-01', 'financial_future_target', 400.00),
        (date '2026-09-01', 'financial_future_gap', 250.00),
        (date '2026-09-01', 'needs_pct', 0.1550),
        (date '2026-09-01', 'wants_pct', 0.0000),
        (date '2026-09-01', 'financial_future_pct', 0.0750),
        (date '2026-09-01', 'unallocated_pct', 0.7700),

        (date '2026-06-01', 'spendable_income', 3025.00),
        (date '2026-06-01', 'financial_future', 650.00),
        (date '2026-06-01', 'financial_future_target', 605.00),
        (date '2026-06-01', 'financial_future_gap', -45.00),
        (date '2026-06-01', 'needs_pct', 0.4092),
        (date '2026-06-01', 'wants_pct', 0.0126),
        (date '2026-06-01', 'financial_future_pct', 0.2149),
        (date '2026-06-01', 'unallocated_pct', 0.3633),

        (date '2026-07-01', 'spendable_income', 0.00),
        (date '2026-07-01', 'financial_future', 0.00),
        (date '2026-07-01', 'financial_future_target', 0.00),
        (date '2026-07-01', 'financial_future_gap', 0.00),
        (date '2026-07-01', 'needs_pct', null),
        (date '2026-07-01', 'wants_pct', null),
        (date '2026-07-01', 'financial_future_pct', null),
        (date '2026-07-01', 'unallocated_pct', null),

        (date '2026-10-01', 'spendable_income', 0.00),
        (date '2026-10-01', 'financial_future', 0.00),
        (date '2026-10-01', 'financial_future_target', 0.00),
        (date '2026-10-01', 'financial_future_gap', 0.00),
        (date '2026-10-01', 'needs_pct', null),
        (date '2026-10-01', 'wants_pct', null),
        (date '2026-10-01', 'financial_future_pct', null),
        (date '2026-10-01', 'unallocated_pct', null),

        (date '2026-05-01', 'spendable_income', 1000.00),
        (date '2026-05-01', 'financial_future', 0.00),
        (date '2026-05-01', 'financial_future_target', 200.00),
        (date '2026-05-01', 'financial_future_gap', 200.00),
        (date '2026-05-01', 'needs_pct', 0.6000),
        (date '2026-05-01', 'wants_pct', 0.4000),
        (date '2026-05-01', 'financial_future_pct', 0.0000),
        (date '2026-05-01', 'unallocated_pct', 0.0000),

        (date '2026-03-01', 'spendable_income', 0.00),
        (date '2026-03-01', 'financial_future', -80.00),
        (date '2026-03-01', 'financial_future_target', 0.00),
        (date '2026-03-01', 'financial_future_gap', 80.00),
        (date '2026-03-01', 'needs_pct', null),
        (date '2026-03-01', 'wants_pct', null),
        (date '2026-03-01', 'financial_future_pct', null),
        (date '2026-03-01', 'unallocated_pct', null),

        (date '2026-04-01', 'spendable_income', 0.00),
        (date '2026-04-01', 'financial_future', 80.00),
        (date '2026-04-01', 'financial_future_target', 0.00),
        (date '2026-04-01', 'financial_future_gap', -80.00),
        (date '2026-04-01', 'needs_pct', null),
        (date '2026-04-01', 'wants_pct', null),
        (date '2026-04-01', 'financial_future_pct', null),
        (date '2026-04-01', 'unallocated_pct', null)

    union all

    select m::date, t.metric, t.value
    from generate_series(date '2026-03-01', date '2026-10-01', interval '1 month') as m
    cross join (values
        ('needs_target_pct', 0.5000),
        ('wants_target_pct', 0.3000),
        ('financial_future_target_pct', 0.2000)
    ) as t (metric, value)
),

actual (month_start, metric, value) as (
    select s.month_start, v.metric, v.value
    from {{ ref('fct_monthly_summary') }} as s
    cross join lateral (values
        ('spendable_income', s.spendable_income),
        ('financial_future', s.financial_future),
        ('financial_future_target', s.financial_future_target),
        ('financial_future_gap', s.financial_future_gap),
        ('needs_pct', s.needs_pct),
        ('wants_pct', s.wants_pct),
        ('financial_future_pct', s.financial_future_pct),
        ('unallocated_pct', s.unallocated_pct),
        ('needs_target_pct', s.needs_target_pct),
        ('wants_target_pct', s.wants_target_pct),
        ('financial_future_target_pct', s.financial_future_target_pct)
    ) as v (metric, value)
    where s.month_start between date '2026-03-01' and date '2026-10-01'
)

select
    coalesce(e.month_start, a.month_start) as month_start,
    coalesce(e.metric, a.metric) as metric,
    e.value as expected,
    a.value as actual
from expected as e
full join actual as a on a.month_start = e.month_start and a.metric = e.metric
where e.value is distinct from a.value
