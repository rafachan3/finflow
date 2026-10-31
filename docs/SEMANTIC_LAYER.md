# Semantic layer

The metric contract. Every number the dashboards (Phase 5), the nudges
Lambda (Phase 4.5) and the analytics agent (Phase 6) report comes from a
metric defined here. The dbt marts implement it and the MetricFlow YAML is
its executable form. If a model disagrees with this file, the model is
wrong. For the tables and columns named below, see
[DATA_MODEL.md](DATA_MODEL.md); for the bucket and subcategory rules, see
[TAXONOMY.md](TAXONOMY.md); for why each definition was chosen, see
[DECISIONS.md](DECISIONS.md) (2026-10-29, "Metric contract").

## Coverage

- Data starts on **2026-06-01** (DECISIONS.md 2026-08-13). Months before it
  are absent, not zero. No metric covers them.
- The Notion import covers 2026-06-01 to 2026-08-12. The bot has logged since
  2026-08-17.
- **August 2026 is partial.** Whether anything was spent or earned from
  2026-08-13 to 2026-08-16 and logged is not confirmed. Until it is, treat
  every August 2026 figure as a lower bound for spend and income, and do not
  compare August 2026 with other months without saying so. Nothing is
  backfilled or imputed.
- Imported rows and bot rows are in the same tables and no metric branches on
  where a row came from. `entry_source = 'import'` (no confirmed `ingestions`
  row) is the only marker.

## Shared definitions

**Ledger.** Every row in `transactions` is confirmed: a row exists only
because a human pressed Confirm (DATA_MODEL invariant). Ingestions in
`pending`, `awaiting_date`, `awaiting_edit` or `discarded` have no
`transactions` row, so they never reach a metric. No metric reads
`ingestions` or `created_at`.

**Month.** The calendar month of `transactions.occurred_on`:
`date_trunc('month', occurred_on)::date`, the mart column `month_start`.
`occurred_on` is already a local calendar date in America/Toronto (a stated
or receipt date, or the Lambda's Toronto "today"), so no time-zone
conversion is applied. A purchase dated June 30 is June, whatever the UTC
time of its Confirm.

**Today.** Only "now"-relative logic needs a zone, and it uses
`(now() at time zone 'America/Toronto')::date`, never `current_date` (the
session time zone is UTC in CI). It decides the last month in the marts
(unless a row is dated later, see "Grain") and
`is_complete_month = month_start < date_trunc('month', <Toronto today>)`.
The current month is always incomplete: read it as month-to-date.

**Currency.** All amounts are CAD `numeric(12,2)`. Money columns stay
`numeric(12,2)`, ratios are `numeric(9,4)`. Nothing is converted to float.

**Lines and headers.** Expense metrics sum **line** amounts
(`transaction_items.amount`), because bucket and subcategory live on the
line. Income and transfers have no lines, so their metrics sum the
**header** amount (`transactions.amount`). The lines of an expense sum to its
header amount exactly (DATA_MODEL invariant, guarded by a dbt test), so an
expense's total is the same either way. Never add a line amount and its
header amount together.

**Own spend line.** A `transaction_items` row whose transaction has
`type = 'expense'` and a funding source named `'self'`
(`funding_sources.name = 'self'` through `transactions.funding_source_id`).
An expense someone else paid for never passed through the owner's accounts.
It is excluded from every spend metric and reported on its own as
`external_spend`.

**Chequing is the null account.** `accounts` holds only savings,
investment and debt accounts (`accounts.kind`, limited by a check
constraint); chequing has no row. A null in any of these three columns means chequing:
`transactions.from_account_id` (the account a transfer leaves),
`transactions.to_account_id` (the one it enters) and
`income_sources.deposit_account_id` (where income from that source lands).
No metric matches an account by name. Every own expense is treated as paid
from chequing.

**Transfers are neither income nor spend.** A transfer is a
`type = 'transfer'` transaction. It names the account it leaves, the one it
enters, or both, never the same account twice (migration 0014's check), so
it has exactly one of three shapes:

| Shape | `from_account_id` | `to_account_id` | Metric |
|---|---|---|---|
| Deposit: chequing to an account | null | set | `transfers` |
| Withdrawal: an account to chequing | set | null | `withdrawals` |
| Move between two accounts | set | set | none |

A contribution to an investment account is a deposit: it is the form a
saving takes, not an extra saving on top. A move between two accounts never
touches chequing, so it is in no metric and changes neither
`unallocated_cash` nor `unspent_rate`; it still counts in
`transaction_count` and has its row in `fct_transactions`. Transfers saved
before migration 0014 have no from account, so every one is a deposit.

**Debt.** A `debt` account (migration 0017; "Car loan", say) is a loan the
owner pays down. It has no balance and no interest; the ledger only records
money going into it.

- A minimum payment is an ordinary own expense line classified `needs`, in
  the loan's subcategory (`Mortgage`, `Car loan payments`, `Student loans`,
  `Personal loans`). It is `spend`, not a transfer.
- An extra payment (anything beyond the minimum) is a deposit-shaped
  transfer from chequing to the debt account, so it counts in `transfers`
  and the `account_kind` dimension splits it out as `debt`.
- Paying a loan from savings or investment is a move between two accounts:
  in no metric, because the owner's net position did not change.
- A debt account only receives transfers. A transfer from a debt account (a
  loan drawdown) is out of scope, and an income source never deposits into
  one, so `savings_income` only ever counts savings and investment accounts.
  Both fail the dbt test `debt_account_only_receives_transfers`.

**Income** is every `type = 'income'` transaction, from any income source,
including interest and refunds, wherever it lands. The part whose source's
`deposit_account_id` is set never reaches chequing and is also reported as
`savings_income`. The deposit account belongs to the source, not the
transaction, so changing a source's deposit account restates every past
month of that source on the next rebuild.

**Refunds count as income.** There is no refund flag. A refund adds to
`income`, and the original purchase stays in `spend` and its bucket, so both
are overstated by the refund. `unspent_rate`'s numerator and
`unallocated_cash` stay exact (the refund and the purchase cancel); the
`unspent_rate` denominator is slightly inflated. A refund does not reduce
`wants_spend`. Upgrade path: a migration adding `income_sources.kind`
(`income | refund`), with refunds then netted against spend, once a refund
visibly distorts a month.

**Bucket.** `transaction_items.bucket` is `needs` or `wants` and NOT NULL;
there is no unclassified bucket. A line with missing context is classified
`wants` and flagged at Confirm (the owner's bucket rules), so every own
spend line is in exactly one bucket and `needs_spend + wants_spend = spend`
holds exactly (dbt test). "Discretionary spend" is a synonym for
`wants_spend`, not a separate metric.

**Recurring.** `transactions.is_recurring` is a header flag that follows the
transaction's link to a recurring series (migration 0016): linking sets it,
unlinking clears it, and deleting a series unlinks its transactions. A
paused series keeps its links: pausing changes expectations, not history.
Until migration 0017, a row flagged before series existed keeps its flag
while the owner's backfill links or clears it. The bot's Confirm writes the
series its card proposed, never Gemini's guess, so a new payment is
recurring exactly when it is linked. Every line of a recurring expense
counts as recurring.

## Grain

`fct_transactions` has one row per ledger line: one row per
`transaction_items` row for an expense, plus one row per income or transfer
transaction (the header stands in for its own line). Its `amount` is the line
amount for an expense line and the header amount otherwise, so every metric
below is a filtered `sum(amount)` over this one table.
`fct_monthly_summary` has one row per month from the first data month to the
current Toronto month, zero-filled, with one column per metric. If a row is
already dated in a later month (a bill logged ahead), the list runs to that
month instead, so no ledger row is left out of every month.
`fct_category_month` has one row per (`month_start`, `subcategory_id`) with
expense data.

## Metrics

Name = `fct_monthly_summary` column = MetricFlow metric name. Every formula
is per month. "Own lines" means own spend lines (above) in that month;
"empty" means the month has no matching rows.

This table is machine-read: each row whose first cell is a backticked name is
a metric, and CI fails if that set differs from the MetricFlow metrics.

| Metric | Meaning | Formula | Edge cases |
|---|---|---|---|
| `income` | Money that came in | `sum(transactions.amount) where type = 'income'` | Empty gives `0`. Includes refunds and interest, and `savings_income`. |
| `savings_income` | Income paid straight into a savings or investment account, such as interest | `sum(transactions.amount) where type = 'income' and income_sources.deposit_account_id is not null`, joining `income_sources.id = transactions.income_source_id` | Empty gives `0`. Part of `income`, never added to it. Never reaches chequing, so `unallocated_cash` subtracts it. A source's deposit account is never a debt account (see Debt above). |
| `spend` | What the owner paid for | `sum(transaction_items.amount)` over own lines | Empty gives `0`. Excludes transfers and `external_spend`. |
| `needs_spend` | Spend on needs | own lines `and bucket = 'needs'` | `= fixed_base_burn + variable_needs`. |
| `wants_spend` | Spend on wants; also called discretionary spend | own lines `and bucket = 'wants'` | `needs_spend + wants_spend = spend`. Refunds do not reduce it. |
| `fixed_base_burn` | The recurring floor of needs | own lines `and bucket = 'needs' and transactions.is_recurring` | A recurring want (a subscription) is not part of it. An annual bill makes its month spike; smoothing is the reader's job. Only as right as `is_recurring`. |
| `variable_needs` | Needs that vary month to month, such as groceries | own lines `and bucket = 'needs' and not transactions.is_recurring` | Partly avoidable, so kept apart from the fixed floor. |
| `external_spend` | Expenses someone else paid for | `sum(transaction_items.amount)` over expense lines whose `funding_sources.name <> 'self'` | Never part of any other spend metric. |
| `transfers` | Money moved out of chequing into savings, investment and debt accounts | `sum(transactions.amount) where type = 'transfer' and from_account_id is null and to_account_id is not null` | Empty gives `0`. A deposit (see the shapes above); a move between two accounts is not one. An extra payment on a loan is one; its minimum payment is `spend`. Split by the destination's kind with the `account_kind` dimension. |
| `withdrawals` | Money moved out of savings and investment accounts back into chequing | `sum(transactions.amount) where type = 'transfer' and from_account_id is not null and to_account_id is null` | Empty gives `0`. Neither income nor negative saving: spending it is what shows, through `spend`. Split by the source account's kind with the `from_account_kind` dimension. |
| `unspent_rate` | Share of income not spent | `round((income - spend) / nullif(income, 0), 4)` | Null when income is `0`. Negative when spend exceeds income. `transfers`, `withdrawals` and moves between accounts do not change it: moving money is neither saving nor spending it. `savings_income` is income not spent, so it raises the rate like any other income. It is not the financial-future rate (money actually moved into a savings, investment or debt account), which is added as its own metric. |
| `unallocated_cash` | Money that reached chequing this month and was neither spent nor moved out | `income - savings_income - spend - transfers + withdrawals` | Chequing's net flow for the month. Positive: surplus still sitting in chequing that should have been moved. Negative: more left chequing than came in, covered by earlier months' surplus. A withdrawal raises it; `savings_income` and a move between two accounts do not change it. |
| `unallocated_cash_cumulative` | Running balance of `unallocated_cash` | `sum(unallocated_cash) over (order by month_start)`, from the first data month up to and including this month | Starts at `0` before 2026-06-01: it measures how chequing changed since coverage began, not its balance (the ledger has no opening balance). A partial month (August 2026) carries into every later month. A deposit or withdrawal that was never logged shows up here as drift. |
| `needs_wants_ratio` | Needs per dollar of wants | `round(needs_spend / nullif(wants_spend, 0), 4)` | Null when `wants_spend` is `0`. A 50/30 split is about `1.67`. |

Columns in `fct_monthly_summary` that are deliberately **not** metrics:
`month_start`, `transaction_count` (distinct transactions in the month),
`is_complete_month`. Promote one only by adding a row above first.

### Reference SQL

The same metrics written directly over `public` tables, with no staging or
marts. The dbt acceptance test recomputes every month this way and fails on
any difference from `fct_monthly_summary`. Months missing from `ledger`
are `0` for money and null for ratios in the mart.

```sql
with ledger as (
  -- expense lines
  select date_trunc('month', t.occurred_on)::date as month_start,
         'expense' as type, i.amount, i.bucket::text as bucket,
         t.is_recurring, f.name = 'self' as is_self_funded,
         null::boolean as from_chequing, null::boolean as to_chequing
  from transactions t
  join transaction_items i on i.transaction_id = t.id
  join funding_sources f   on f.id = t.funding_source_id
  where t.type = 'expense'
  union all
  -- income and transfer headers; a null account is chequing
  select date_trunc('month', t.occurred_on)::date, t.type::text, t.amount,
         null, t.is_recurring, null,
         t.from_account_id is null,
         case when t.type = 'income' then s.deposit_account_id
              else t.to_account_id end is null
  from transactions t
  left join income_sources s on s.id = t.income_source_id
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
)
select m.*,
  round((income - spend) / nullif(income, 0), 4) as unspent_rate,
  income - savings_income - spend - transfers + withdrawals as unallocated_cash,
  sum(income - savings_income - spend - transfers + withdrawals)
    over (order by month_start) as unallocated_cash_cumulative,
  round(needs_spend / nullif(wants_spend, 0), 4) as needs_wants_ratio
from monthly m
order by month_start;
```

The running sum must run over the zero-filled month list (see "Grain"), which
this query does not produce; in the mart a month with no rows still carries
the previous balance forward. The dbt test builds that list itself with
`generate_series`, not from `dim_date`.

## Recipes

Recipes are filters on `fct_transactions`, not metrics. They are written
here so the dashboard and the agent compute them the same way.

- **Spend ex-rent** (Phase 5's cumulative monthly spend view): `spend`
  minus the own spend lines with `subcategory_name = 'Rent'`. It already
  excludes externally funded expenses, because `spend` does.
- **Spend by context tag:** own spend lines where `'<tag>' = any(tags)`.
  `fct_transactions.tags` is a line's effective tags: its own line tags plus
  its transaction's header tags.
- **Transfers by account kind:** `transfers` grouped by `account_kind`
  (`savings`, `investment`, `debt`), the kind of the account entered.
- **Withdrawals by account kind:** `withdrawals` grouped by
  `from_account_kind`, the kind of the account left.

## Adding or changing a metric

1. Add or edit its row in the metric table here, with the formula and edge
   cases, and a DECISIONS.md entry if it settles a choice.
2. Add it to the MetricFlow YAML.
3. Add the `fct_monthly_summary` column and extend the reference SQL and its
   dbt test.

CI fails if the metric names here and in the MetricFlow YAML differ, or if
`mf query` and the mart disagree for any month.
