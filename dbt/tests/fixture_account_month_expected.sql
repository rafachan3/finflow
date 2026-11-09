-- fct_account_month on the fixture against values worked out by hand
-- from fixtures/synthetic.sql. Tagged `fixture`.
--
-- Opening: Emergency fund 1000.00 as of 2026-05-31. Retirement account
-- (investment) and Car loan (debt) have none, so their balance is always
-- null. The May 31 interest (2.50) is on as_of, so it is in the snapshot
-- and not in May's post-opening flow.
--
-- Emergency fund net_flow / cumulative / balance:
--   03  -80.00 /  -80.00 / null       (month ends before as_of)
--   04   80.00 /    0.00 / null
--   05    2.50 /    2.50 / 1000.00    (as_of month: opening, no flow after)
--   06  154.12 /  156.62 / 1154.12    (500 in - 150 out - 200 move + 4.12)
--   07    0.00 /  156.62 / 1154.12
--   08  300.00 /  456.62 / 1454.12
--   09 -100.00 /  356.62 / 1354.12    (100 to Car loan)
--   10    0.00 /  356.62 / 1354.12
-- Retirement Jun 300 deposit + 200 move in = 500; Aug +200 → cum 700.
-- Car loan Sep 150 deposit + 100 move in = 250.
{{ config(tags=['fixture']) }}

with expected (month_start, account_name, col, value) as (
    values
        (date '2026-03-01', 'Emergency fund', 'withdrawals', 80.00),
        (date '2026-03-01', 'Emergency fund', 'net_flow', -80.00),
        (date '2026-03-01', 'Emergency fund', 'net_flow_cumulative', -80.00),
        (date '2026-03-01', 'Emergency fund', 'balance', null),

        (date '2026-05-01', 'Emergency fund', 'savings_income', 2.50),
        (date '2026-05-01', 'Emergency fund', 'net_flow', 2.50),
        (date '2026-05-01', 'Emergency fund', 'balance', 1000.00),

        (date '2026-06-01', 'Emergency fund', 'deposits', 500.00),
        (date '2026-06-01', 'Emergency fund', 'withdrawals', 150.00),
        (date '2026-06-01', 'Emergency fund', 'moves_out', 200.00),
        (date '2026-06-01', 'Emergency fund', 'savings_income', 4.12),
        (date '2026-06-01', 'Emergency fund', 'net_flow', 154.12),
        (date '2026-06-01', 'Emergency fund', 'net_flow_cumulative', 156.62),
        (date '2026-06-01', 'Emergency fund', 'balance', 1154.12),

        (date '2026-08-01', 'Emergency fund', 'deposits', 300.00),
        (date '2026-08-01', 'Emergency fund', 'balance', 1454.12),

        (date '2026-09-01', 'Emergency fund', 'moves_out', 100.00),
        (date '2026-09-01', 'Emergency fund', 'net_flow_cumulative', 356.62),
        (date '2026-09-01', 'Emergency fund', 'balance', 1354.12),

        (date '2026-06-01', 'Retirement account', 'deposits', 300.00),
        (date '2026-06-01', 'Retirement account', 'moves_in', 200.00),
        (date '2026-06-01', 'Retirement account', 'net_flow', 500.00),
        (date '2026-06-01', 'Retirement account', 'balance', null),

        (date '2026-08-01', 'Retirement account', 'deposits', 200.00),
        (date '2026-08-01', 'Retirement account', 'net_flow_cumulative', 700.00),
        (date '2026-08-01', 'Retirement account', 'balance', null),

        (date '2026-09-01', 'Car loan', 'deposits', 150.00),
        (date '2026-09-01', 'Car loan', 'moves_in', 100.00),
        (date '2026-09-01', 'Car loan', 'net_flow', 250.00),
        (date '2026-09-01', 'Car loan', 'balance', null)
),

actual (month_start, account_name, col, value) as (
    select a.month_start, a.account_name, v.col, v.value
    from {{ ref('fct_account_month') }} as a
    cross join lateral (values
        ('deposits', a.deposits),
        ('withdrawals', a.withdrawals),
        ('moves_in', a.moves_in),
        ('moves_out', a.moves_out),
        ('savings_income', a.savings_income),
        ('net_flow', a.net_flow),
        ('net_flow_cumulative', a.net_flow_cumulative),
        ('balance', a.balance)
    ) as v (col, value)
)

select e.month_start, e.account_name, e.col, e.value as expected, a.value as actual
from expected as e
left join actual as a
    on a.month_start = e.month_start
   and a.account_name = e.account_name
   and a.col = e.col
where a.month_start is null or e.value is distinct from a.value

union all

select null, account_name, 'account_kind', null, null
from {{ ref('fct_account_month') }}
group by account_name, account_kind
having account_name = 'Emergency fund' and account_kind is distinct from 'savings'
    or account_name = 'Retirement account' and account_kind is distinct from 'investment'
    or account_name = 'Car loan' and account_kind is distinct from 'debt'

union all

select null, null, 'rows', 24, count(*)
from {{ ref('fct_account_month') }}
having count(*) <> 24
    or min(month_start) is distinct from date '2026-03-01'
    or max(month_start) is distinct from date '2026-10-01'
