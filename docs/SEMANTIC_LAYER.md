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
session time zone is UTC in CI). It decides the last month in the marts and
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

**Transfers are neither income nor spend.** A transfer is a
`type = 'transfer'` transaction to `transactions.to_account_id`. The
destination's type is `accounts.kind`, which a check constraint limits to
`savings` or `investment`. A contribution to an investment account is a
transfer: it is the form a saving takes, not an extra saving on top. The
schema has no source account, so a withdrawal from savings back to chequing
cannot be recorded (see `unallocated_cash`).

**Income** is every `type = 'income'` transaction, from any income source,
including interest and refunds.

**Refunds count as income.** There is no refund flag. A refund adds to
`income`, and the original purchase stays in `spend` and its bucket, so both
are overstated by the refund. `savings_rate`'s numerator and
`unallocated_cash` stay exact (the refund and the purchase cancel); the
`savings_rate` denominator is slightly inflated. A refund does not reduce
`wants_spend`. Upgrade path: a migration adding `income_sources.kind`
(`income | refund`), with refunds then netted against spend, once a refund
visibly distorts a month.

**Bucket.** `transaction_items.bucket` is `needs` or `wants` and NOT NULL;
there is no unclassified bucket. A line with missing context is classified
`wants` and flagged at Confirm (the owner's bucket rules), so every own
spend line is in exactly one bucket and `needs_spend + wants_spend = spend`
holds exactly (dbt test). "Discretionary spend" is a synonym for
`wants_spend`, not a separate metric.

**Recurring.** `transactions.is_recurring` is a header flag. Every line of a
recurring expense counts as recurring.

## Grain

`fct_transactions` has one row per ledger line: one row per
`transaction_items` row for an expense, plus one row per income or transfer
transaction (the header stands in for its own line). Its `amount` is the line
amount for an expense line and the header amount otherwise, so every metric
below is a filtered `sum(amount)` over this one table.
`fct_monthly_summary` has one row per month from the first data month to the
current Toronto month, zero-filled, with one column per metric.
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
| `income` | Money that came in | `sum(transactions.amount) where type = 'income'` | Empty gives `0`. Includes refunds and interest. |
| `spend` | What the owner paid for | `sum(transaction_items.amount)` over own lines | Empty gives `0`. Excludes transfers and `external_spend`. |
| `needs_spend` | Spend on needs | own lines `and bucket = 'needs'` | `= fixed_base_burn + variable_needs`. |
| `wants_spend` | Spend on wants; also called discretionary spend | own lines `and bucket = 'wants'` | `needs_spend + wants_spend = spend`. Refunds do not reduce it. |
| `fixed_base_burn` | The recurring floor of needs | own lines `and bucket = 'needs' and transactions.is_recurring` | A recurring want (a subscription) is not part of it. An annual bill makes its month spike; smoothing is the reader's job. Only as right as `is_recurring`. |
| `variable_needs` | Needs that vary month to month, such as groceries | own lines `and bucket = 'needs' and not transactions.is_recurring` | Partly avoidable, so kept apart from the fixed floor. |
| `external_spend` | Expenses someone else paid for | `sum(transaction_items.amount)` over expense lines whose `funding_sources.name <> 'self'` | Never part of any other spend metric. |
| `transfers` | Money moved to savings and investment accounts | `sum(transactions.amount) where type = 'transfer' and accounts.kind in ('savings', 'investment')`, joining `accounts.id = transactions.to_account_id` | Today every transfer qualifies (check constraint). A new account kind would be excluded until this row says otherwise. Split by kind with the `account_kind` dimension. |
| `savings_rate` | Share of income not spent | `round((income - spend) / nullif(income, 0), 4)` | Null when income is `0`. Negative when spend exceeds income. Transfers do not change it: moving last month's surplus is not a new saving. |
| `unallocated_cash` | Money left over this month that was not moved to savings or investment | `income - spend - transfers` | Positive: surplus still sitting in chequing that should have been moved. Negative: more was spent or moved than came in, covered by money from earlier months or by an unrecorded withdrawal. Interest paid straight into a savings or investment account counts as income but never reaches chequing, so it inflates this by its amount. |
| `unallocated_cash_cumulative` | Running balance of `unallocated_cash` | `sum(unallocated_cash) over (order by month_start)`, from the first data month up to and including this month | Starts at `0` before 2026-06-01: it measures the drift since coverage began, not the chequing balance. A partial month (August 2026) carries into every later month. |
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
         null::text as account_kind
  from transactions t
  join transaction_items i on i.transaction_id = t.id
  join funding_sources f   on f.id = t.funding_source_id
  where t.type = 'expense'
  union all
  -- income and transfer headers
  select date_trunc('month', t.occurred_on)::date, t.type::text, t.amount,
         null, t.is_recurring, null, a.kind
  from transactions t
  left join accounts a on a.id = t.to_account_id
  where t.type <> 'expense'
), monthly as (
  select month_start,
    coalesce(sum(amount) filter (where type = 'income'), 0) as income,
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
                                   and account_kind in ('savings', 'investment')), 0) as transfers
  from ledger
  group by month_start
)
select m.*,
  round((income - spend) / nullif(income, 0), 4) as savings_rate,
  income - spend - transfers as unallocated_cash,
  sum(income - spend - transfers) over (order by month_start) as unallocated_cash_cumulative,
  round(needs_spend / nullif(wants_spend, 0), 4) as needs_wants_ratio
from monthly m
order by month_start;
```

The running sum must run over the zero-filled month list, which this
query does not produce; in the mart a month with no rows still carries the
previous balance forward.

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
  (`savings`, `investment`).

## Adding or changing a metric

1. Add or edit its row in the metric table here, with the formula and edge
   cases, and a DECISIONS.md entry if it settles a choice.
2. Add it to the MetricFlow YAML.
3. Add the `fct_monthly_summary` column and extend the reference SQL and its
   dbt test.

CI fails if the metric names here and in the MetricFlow YAML differ, or if
`mf query` and the mart disagree for any month.
