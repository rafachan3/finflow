# Semantic layer

The metric contract. Every number the dashboards (Phase 5), the nudges
Lambda (Phase 4.5) and the analytics agent (Phase 6) report comes from a
metric or a planning mart defined here. The dbt marts implement it and the
MetricFlow YAML is the metrics' executable form. If a model disagrees with
this file, the model is wrong. For the tables and columns named below, see
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
The current month is always incomplete: read it as month-to-date. The dbt
var `today` (environment `FINFLOW_TODAY`) replaces Toronto's today with a
fixed date. Only the synthetic fixture sets it, so its current month never
moves; production never does.

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

**Spendable income and financial future (the 50/30/20 view).** Each month
splits the money that reached chequing, `spendable_income`, into four parts:
`needs_spend`, `wants_spend`, `financial_future` and `unallocated_cash`
(what is still in chequing). `spendable_income` is `income` without
`savings_income`: salary, refunds and one-off income count, but
interest paid inside a savings or investment account is growth, not income,
in this view. `financial_future` is money actually moved: `transfers` (into
savings, investment and debt accounts, so a loan's extra payment counts)
minus `withdrawals` (a withdrawal lowers that month's financial future). A
move between two accounts is in neither. Cash left in chequing is not
financial future until it is moved. A transfer counts in the month of its
`occurred_on`, so one dated into the month it belongs to needs no
carry-over. Because `unallocated_cash = spendable_income - spend -
financial_future` by its formula, the identity `spendable_income = spend +
financial_future + unallocated_cash` holds exactly every month, and the four
`*_pct` shares sum to `1` within `0.0005` (each rounded to 4 places) whenever
`spendable_income > 0` (dbt test `financial_future_identity`).
`external_spend` is in none of them.

**Targets.** The 50/30/20 targets are one row in `budget_targets`
(migration 0018), stored as percentages `0`-`100` that sum to `100` and
seeded `50/30/20`; a person changes them with an UPDATE in their untracked
seed overlay. The marts expose them as fractions (`*_target_pct`, the stored
value divided by `100`) so they compare directly with the `*_pct` shares.
They apply to every month, with no effective dates: changing them restates
history on the next rebuild. Which direction is better (needs and wants at
most their target, financial future at least) is not encoded in any metric;
the reader decides. `fct_transactions` carries the three fractions on every
row so MetricFlow can read them.

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
Since migration 0020 a CHECK makes the flag exactly the link, so a payment
is recurring exactly when it is linked. The bot's Confirm writes the series
its card proposed, never Gemini's guess. Every line of a recurring expense
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
`fct_ledger_entry` has one row per `transactions` row (the header). It is a
listing mart for the Ledger dashboard, not a metric: no MetricFlow model,
and nothing in `fct_monthly_summary` is summed from it. Its `amount` is the
header amount. Expense line detail stays on `fct_transactions`; the ledger
joins the two on `transaction_id`.
`fct_month_rolling` has one row per (`month_start`, `window_months`) for
every month of the month list and every N in the dbt var `window_months`.
It is a planning mart, not a metric: no MetricFlow model. Money sums and
share ratios are null unless the whole window is complete.
`fct_month_plan.*_pct_3m` is N = 3 of this mart.
`fct_account_month` has one row per (`month_start`, account) for every
month of the month list and every `accounts` row, zero-filled. It is an
account mart, not a metric: no MetricFlow model. `balance` is null without
an opening, before `as_of`, and for investment and debt.

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
| `unspent_rate` | Share of income not spent | `round((income - spend) / nullif(income, 0), 4)` | Null when income is `0`. Negative when spend exceeds income. `transfers`, `withdrawals` and moves between accounts do not change it: moving money is neither saving nor spending it. `savings_income` is income not spent, so it raises the rate like any other income. It is not `financial_future_pct` (money actually moved into a savings, investment or debt account). |
| `unallocated_cash` | Money that reached chequing this month and was neither spent nor moved out | `income - savings_income - spend - transfers + withdrawals` | Chequing's net flow for the month. Positive: surplus still sitting in chequing that should have been moved. Negative: more left chequing than came in, covered by earlier months' surplus. A withdrawal raises it; `savings_income` and a move between two accounts do not change it. |
| `unallocated_cash_cumulative` | Running balance of `unallocated_cash` | `sum(unallocated_cash) over (order by month_start)`, from the first data month up to and including this month | Starts at `0` before 2026-06-01: it measures how chequing changed since coverage began, not its balance (the ledger has no opening balance). A partial month (August 2026) carries into every later month. A deposit or withdrawal that was never logged shows up here as drift. |
| `needs_wants_ratio` | Needs per dollar of wants | `round(needs_spend / nullif(wants_spend, 0), 4)` | Null when `wants_spend` is `0`. A 50/30 split is about `1.67`. |
| `spendable_income` | Income that reached chequing: the base of the 50/30/20 view | `income - savings_income` | Empty gives `0`. Refunds and other income count; interest paid inside a savings or investment account does not. `= spend + financial_future + unallocated_cash` exactly. |
| `financial_future` | Money set aside: moved into savings, investment and debt accounts, minus money taken back out | `transfers - withdrawals` | Empty gives `0`. Negative when more came out than went in. A loan's extra payment counts through `transfers`; its minimum payment is `spend`. A move between two accounts, `savings_income` and cash left in chequing are not part of it. |
| `needs_target_pct` | Target share of `spendable_income` for needs | `budget_targets.needs_percent / 100` | Not computed from the ledger: the same every month, `0.5` as seeded. Changing the row restates every month on the next rebuild. |
| `wants_target_pct` | Target share of `spendable_income` for wants | `budget_targets.wants_percent / 100` | As `needs_target_pct`; `0.3` as seeded. |
| `financial_future_target_pct` | Target share of `spendable_income` for financial future | `budget_targets.financial_future_percent / 100` | As `needs_target_pct`; `0.2` as seeded. The three targets sum to `1`. |
| `financial_future_target` | Dollars the target asks to set aside this month | `round(financial_future_target_pct * spendable_income, 2)` | `0` when `spendable_income` is `0`. |
| `financial_future_gap` | Dollars still to move to reach the target | `financial_future_target - financial_future` | Positive: move this much more. Negative: ahead of target. The current month shows a large gap until the money is moved; `is_complete_month` marks it. |
| `needs_pct` | Needs as a share of spendable income | `round(needs_spend / nullif(spendable_income, 0), 4)` | Null when `spendable_income` is `0`, like every `*_pct` share. Compare with `needs_target_pct`. |
| `wants_pct` | Wants as a share of spendable income | `round(wants_spend / nullif(spendable_income, 0), 4)` | Compare with `wants_target_pct`. Refunds do not reduce it. |
| `financial_future_pct` | Financial future as a share of spendable income | `round(financial_future / nullif(spendable_income, 0), 4)` | Negative when more came out than went in. Compare with `financial_future_target_pct`. |
| `unallocated_pct` | Share of spendable income still in chequing | `round(unallocated_cash / nullif(spendable_income, 0), 4)` | Negative when more left chequing than came in. With the other three it sums to `1` within `0.0005` when `spendable_income > 0`. |

Columns in `fct_monthly_summary` that are deliberately **not** metrics:
`month_start`, `transaction_count` (distinct transactions in the month),
`is_complete_month`. Promote one only by adding a row above first.

### Reference SQL

The same metrics written directly over `public` tables, with no staging or
marts. The dbt acceptance test recomputes every month this way and fails on
any difference from `fct_monthly_summary`. Months missing from `ledger`
are `0` for money and null for ratios in the mart, and still carry the
three targets.

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
  round(needs_spend / nullif(wants_spend, 0), 4) as needs_wants_ratio,
  income - savings_income as spendable_income,
  transfers - withdrawals as financial_future,
  b.needs_percent / 100 as needs_target_pct,
  b.wants_percent / 100 as wants_target_pct,
  b.financial_future_percent / 100 as financial_future_target_pct,
  round(b.financial_future_percent / 100 * (income - savings_income), 2)
    as financial_future_target,
  round(b.financial_future_percent / 100 * (income - savings_income), 2)
    - (transfers - withdrawals) as financial_future_gap,
  round(needs_spend / nullif(income - savings_income, 0), 4) as needs_pct,
  round(wants_spend / nullif(income - savings_income, 0), 4) as wants_pct,
  round((transfers - withdrawals) / nullif(income - savings_income, 0), 4)
    as financial_future_pct,
  round((income - savings_income - spend - transfers + withdrawals)
        / nullif(income - savings_income, 0), 4) as unallocated_pct
from monthly m
cross join budget_targets b  -- one row, migration 0018
order by month_start;
```

The running sum must run over the zero-filled month list (see "Grain"), which
this query does not produce; in the mart a month with no rows still carries
the previous balance forward. The dbt test builds that list itself with
`generate_series`, not from `dim_date`.

## Recipes

Recipes are filters on `fct_transactions`, not metrics. They are written
here so the dashboard and the agent compute them the same way.

- **Spend ex-rent:** `spend` minus the own spend lines with
  `subcategory_name = 'Rent'`. It already excludes externally funded
  expenses, because `spend` does.
- **Spend by context tag:** own spend lines where `'<tag>' = any(tags)`.
  `fct_transactions.tags` is a line's effective tags: its own line tags plus
  its transaction's header tags.
- **Transfers by account kind:** `transfers` grouped by `account_kind`
  (`savings`, `investment`, `debt`), the kind of the account entered.
- **Withdrawals by account kind:** `withdrawals` grouped by
  `from_account_kind`, the kind of the account left.
- **Rolling mean of a slice:** the mean of a filtered slice's own spend
  over month M and the 2 months before it, over `fct_month_plan`'s month
  list, so a month with no matching line counts as 0. Like rolling N = 3
  shares, it is null unless all three months are complete: the first two
  months of the list and the current month have none.

  ```sql
  select p.month_start, p.is_complete_month,
         coalesce(s.spend, 0) as spend,
         case when count(*) filter (where p.is_complete_month) over w = 3
              then round(avg(coalesce(s.spend, 0)) over w, 2) end as spend_mean_3m
  from marts.fct_month_plan p
  left join (
    select month_start, sum(amount) as spend
    from marts.fct_transactions
    where type = 'expense' and is_self_funded  -- own spend lines
      and bucket = 'wants'                     -- the slice's filters
    group by month_start
  ) s using (month_start)
  window w as (order by p.month_start rows between 2 preceding and current row)
  order by p.month_start;
  ```

## Planning marts (dashboard support)

Planning marts turn the metrics above into plans, pace, baselines and
rolling windows for the Phase 5 dashboards. Phase 6's agent reads them
directly. They are **not metrics**: none is a `fct_monthly_summary` column
or a MetricFlow metric, because the metric table must equal the MetricFlow
YAML and MetricFlow cannot express "complete preceding months only". Every
value is built from a metric above with that metric's own filter, so it
traces back to this file. Why the current month is planned in dollars from
an expected income, and not as a share of income so far:
DECISIONS.md 2026-11-07. Why rolling windows are a long-format mart, not
extra columns on `fct_month_plan`: DECISIONS.md 2026-11-08.

Terms used below:

- **Month list.** The months of `fct_monthly_summary` from the month of the
  ledger start (dbt var `ledger_start`) on. A month before the ledger start
  is left out, even if a stray row is dated in it.
- **Current month.** The month of Toronto's today. A month after it exists
  only when a row is dated tomorrow across a month end. It is a **future
  month**: nothing in it has happened yet.
- **Baseline months** of month M. The complete months among the 3 months
  of the list before M (`baseline_months`, 0 to 3). With 3 complete months
  before November, November's baseline is August to October. A complete
  month with no rows counts as 0. A **baseline** (`_baseline`, `_avg_3m`) is
  the mean over the baseline months, so M is never compared with itself.
  It is null when `baseline_months = 0`.
- **Rolling N months.** M and the N − 1 months before it, only when all N
  are complete and in the list. It is a ratio of sums, not a mean of
  ratios, so a low-income month does not get extra weight. The four
  `*_pct` shares divide by `sum(spendable_income)`; `unspent_rate` divides
  by `sum(income)`. `fct_month_plan.*_pct_3m` is N = 3, unchanged.
  `fct_month_rolling` holds every N in the dbt var `window_months`
  (default 3 and 12).

Rounding: money is `numeric(12,2)`, ratios and mean line counts are
`numeric(9,4)`. A mean is rounded once, from the exact sum. A column built
from another column of the same mart (`spendable_income_expected`, the
plans, `spend_delta`) uses that column's rounded value, so the columns a
reader sees reconcile.

### `fct_month_plan`

One row per month of the month list.

| Column | Formula | Edge cases |
|---|---|---|
| `month_start`, `is_complete_month`, `spendable_income` | from `fct_monthly_summary` | |
| `days_in_month` | days in the calendar month | |
| `as_of_day` | `days_in_month` for a complete month; Toronto today's day of month for the current month; `0` for a future month | |
| `baseline_months` | count of the baseline months | `0` in the first month of the list |
| `spendable_income_baseline` | mean `spendable_income` over the baseline months | Null when `baseline_months = 0` |
| `spendable_income_expected` | A complete month: `spendable_income`. Otherwise `greatest(spendable_income, spendable_income_baseline)` | **Null when `baseline_months = 0`** in an incomplete month. Postgres `greatest` ignores nulls, so the `case` is written out; otherwise the plan would fall back to income so far. It follows income upward the moment income so far passes the baseline, and never downward |
| `income_received_share` | `round(spendable_income / nullif(spendable_income_expected, 0), 4)` | `1` in a complete month with income; null with no expected income |
| `needs_plan`, `wants_plan`, `financial_future_plan` | `round(<bucket>_target_pct * spendable_income_expected, 2)` | In a complete month each equals `target_pct * spendable_income`, and `financial_future_plan = financial_future_target` |
| `needs_pct_3m`, `wants_pct_3m`, `financial_future_pct_3m`, `unallocated_pct_3m` | `round(sum(<needs_spend, wants_spend, financial_future, unallocated_cash>) / nullif(sum(spendable_income), 0), 4)` over the rolling 3 months | N = 3 of Rolling N months. Null unless all three months are complete and in the list; null when their `spendable_income` sums to `0` |

Reference SQL for the plan, over `fct_monthly_summary` (`m` is the month
list, `b` its baseline). The `rows` frames count months, because the month
list is zero-filled.

```sql
select month_start,
  case when is_complete_month then spendable_income
       when baseline_months > 0 then greatest(spendable_income, spendable_income_baseline)
  end as spendable_income_expected
from (
  select month_start, is_complete_month, spendable_income,
    count(*) filter (where is_complete_month) over b as baseline_months,
    round(avg(spendable_income) filter (where is_complete_month) over b, 2)
      as spendable_income_baseline
  from marts.fct_monthly_summary
  where month_start >= date_trunc('month', '<ledger_start>'::date)
  window b as (order by month_start rows between 3 preceding and 1 preceding)
) m;
```

### `fct_month_rolling`

One row per (`month_start`, `window_months`) for every month of the month
list and every N in the dbt var `window_months` (default 3 and 12). Long
format: a dashboard filters `window_months`. Built from
`fct_monthly_summary`, independently of `fct_month_plan`, so N = 3 can be
checked against `*_pct_3m`.

| Column | Formula | Edge cases |
|---|---|---|
| `month_start` | from the month list | |
| `window_months` | N, one of the var's values | |
| `complete_months_in_window` | count of complete months among M and the N − 1 months before it that are in the list | Less than N at the start of the list, and whenever the window includes the current or a future month |
| `spendable_income`, `needs_spend`, `wants_spend`, `financial_future`, `unallocated_cash`, `spend`, `income` | `sum` of that metric over the window | **Null unless** `complete_months_in_window = window_months`. A complete month with no rows counts as 0 |
| `needs_pct`, `wants_pct`, `financial_future_pct`, `unallocated_pct` | `round(sum(<metric>) / nullif(sum(spendable_income), 0), 4)` | Null unless the whole window is complete; null when `sum(spendable_income)` is 0. N = 3 equals `fct_month_plan.*_pct_3m` |
| `unspent_rate` | `round((sum(income) - sum(spend)) / nullif(sum(income), 0), 4)` | Null unless the whole window is complete; null when `sum(income)` is 0 |

Reference SQL for one N (3). The mart unions each N in `window_months` the
same way. The `rows` frame counts months, because the month list is
zero-filled.

```sql
select month_start, 3 as window_months,
  count(*) filter (where is_complete_month) over w as complete_months_in_window,
  case when count(*) filter (where is_complete_month) over w = 3
       then sum(spendable_income) over w end as spendable_income
from marts.fct_monthly_summary
where month_start >= date_trunc('month', '<ledger_start>'::date)
window w as (order by month_start rows between 2 preceding and current row);
```

### `fct_pace_day`

One row per (`date_day`, `series`) for every day of every month of the
month list, five series per day. Each series uses exactly its metric's
filter, summed by `occurred_on`:

| `series` | Metric it follows |
|---|---|
| `needs` | `needs_spend` |
| `wants` | `wants_spend` |
| `variable_needs` | `variable_needs` |
| `financial_future` | `financial_future` (transfers in, withdrawals out, so it can fall) |
| `spendable_income` | `spendable_income` |

| Column | Formula | Edge cases |
|---|---|---|
| `date_day`, `month_start`, `day_of_month`, `series` | | |
| `amount_day` | the series' sum on that day | `0` on a day with no rows. Null on a day after Toronto's today |
| `amount_mtd` | the running sum of `amount_day` within the month, through that day | As `amount_day`. On the last day of a complete month it equals that month's metric in `fct_monthly_summary` |
| `month_total` | the series' total for the month | Complete months only, null otherwise |
| `pace_mtd_avg_3m` | mean over the baseline months of their `amount_mtd` on the matching day. Read: "what I usually have by this day" | Null when `baseline_months = 0`. Kept on days after today, so the usual curve draws to month end |
| `pace_share_avg_3m` | mean over the baseline months of `amount_mtd / nullif(month_total, 0)` on the matching day. Read: "the share of a month usually done by today" | A baseline month with a `0` total is left out of the mean. Null when all of them total `0` or `baseline_months = 0`. `1` on the last day of the month whenever it is not null |

**The matching day.** Days are aligned by day of month, not by fraction of
the month, because rent and paydays fall on fixed dates. Day d of M matches
day `least(d, days in the baseline month)`, so day 31 against a 30-day
month reads its day 30. **The last day of M matches the last day of each
baseline month**, so a 30-day M still closes at the baseline months' full
totals and a February picks up the 29th to 31st of a longer month. Without
that, a transfer made on the 31st, the usual day for one, would never
reach a 30-day month's curve.

### `fct_subcategory_month`

One row per (`month_start`, `bucket`, `subcategory_id`) for every month of
the month list and every (bucket, subcategory) pair that has an own spend
line in some month of the list, **zero-filled**. Without the zero-fill a
mean would skip the months a subcategory was absent and run high. Carries
`category_name` and `subcategory_name`.

| Column | Formula | Edge cases |
|---|---|---|
| `spend` | `sum(amount)` over own spend lines in that bucket and subcategory | `0` in a month without one. Summed over bucket it equals `fct_category_month.spend` |
| `line_count` | count of those lines | `0` likewise. Lines someone else paid for are not counted, unlike `fct_category_month.line_count` |
| `baseline_months` | count of the baseline months | |
| `spend_avg_3m`, `line_count_avg_3m` | mean `spend` and `line_count` over the baseline months, zeros included | Null when `baseline_months = 0` |
| `spend_to_date_avg_3m` | the sum over the baseline months of their own spend dated on or before the matching day of this month's `as_of_day` (`fct_pace_day`'s rule), divided by `baseline_months`. Read: "what the previous months had by this day", so a month in progress is compared like for like | Null when `baseline_months = 0`. Equals `spend_avg_3m` in a complete month. `0` in a future month. Summed over a bucket it is that bucket's `fct_pace_day.pace_mtd_avg_3m` on `as_of_day`, within rounding |
| `spend_delta` | `spend - spend_avg_3m` | Null when `baseline_months = 0` |
| `is_few_lines` | `line_count + 3 * coalesce(line_count_avg_3m, 0) < 6`: fewer than 6 lines across the 4 months compared, scaled to 3 baseline months | Computed from the exact mean. A subcategory-month this thin is mostly noise: show it, flagged, never rank by it |

## Listing marts (dashboard support)

`fct_ledger_entry` lists whole logged entries for the Phase 5 Ledger
dashboard and Phase 6's agent. It is **not a metric**: no
`fct_monthly_summary` column and no MetricFlow metric. Nested line items
are read from `fct_transactions` on `transaction_id`. Why the grain is the
header, and how the derived columns are shaped: DECISIONS.md 2026-11-08.

### `fct_ledger_entry`

One row per `stg_transactions` row.

| Column | Formula | Edge cases |
|---|---|---|
| `transaction_id`, `occurred_on`, `month_start`, `type`, `amount`, `description`, `notes`, `merchant_name`, `venue_name`, `income_source_name`, `from_account_name`, `to_account_name`, `funding_source_name`, `is_recurring`, `recurring_series_name`, `recurring_cadence`, `entry_source` | from `stg_transactions`; `amount` is the header | A null account name is chequing. Series name and cadence are null when unlinked |
| `counterparty` | expense: `merchant · venue`, omitting a missing side; income: `income_source_name`; transfer: `from → to` with a null side shown as `Chequing` | Null when an expense has neither merchant nor venue |
| `is_self_funded` | expense: `funding_source_name = 'self'`; otherwise null | |
| `line_count` | count of expense lines | `0` on income and transfers |
| `category_summary` | `category › subcategory` of the largest-amount line, then ` +n` for *n* other distinct paths | Null on income and transfers. A tie breaks on category, subcategory, then item id. Two lines in the same path do not add `+n` |
| `subcategory_paths` | distinct `category › subcategory` of the lines, ordered by the largest line in that path, then the path | `'{}'` on income and transfers |
| `bucket_summary` | `needs`, `wants`, or `mixed` when both `needs_amount` and `wants_amount` are `> 0` | Null on income and transfers |
| `needs_amount`, `wants_amount` | sum of line amounts in that bucket | `0` on income and transfers. On an expense they sum to `amount` |
| `tags` | distinct union of header tags and line tags, sorted | `'{}'` when none |

## Account marts (dashboard support)

`fct_account_month` turns each named account's flows into a monthly line
for Trends T4/T5. It is **not a metric**: no `fct_monthly_summary` column
and no MetricFlow metric. Chequing is the null side of the account FKs, so
it is not a row here. Why a savings opening becomes a balance and an
investment account does not: DECISIONS.md 2026-11-08.

### `fct_account_month`

One row per (`month_start`, account) for every month of the month list and
every `accounts` row, **zero-filled**.

| Column | Formula | Edge cases |
|---|---|---|
| `month_start`, `account_name`, `account_kind` | month list × `accounts` | |
| `deposits` | `sum(amount)` of transfers **from chequing into this account** (`from_account_id` null, `to_account_id` this) | `0` with none. Summed across accounts it equals `transfers` |
| `withdrawals` | `sum(amount)` of transfers **from this account into chequing** (`from_account_id` this, `to_account_id` null) | `0` with none. Summed across accounts it equals `withdrawals` |
| `moves_in` | `sum(amount)` of transfers **from another named account into this one** (both FKs set, `to_account_id` this) | `0` with none. Per month, `sum(moves_in) = sum(moves_out)` |
| `moves_out` | `sum(amount)` of transfers **from this account into another named account** (both FKs set, `from_account_id` this) | `0` with none |
| `savings_income` | `sum(amount)` of income whose source deposits into this account | `0` with none. The same filter as `savings_income` the metric, split by account |
| `net_flow` | `deposits + moves_in + savings_income - withdrawals - moves_out` | |
| `net_flow_cumulative` | running sum of `net_flow` per account, from the first month of the list | Investment's contributed-since-tracking figure |
| `balance` | `opening.amount + sum(signed flows where occurred_on > as_of and occurred_on ≤ month end)` | **Null** without an `account_opening_balances` row; **null** when the month ends before `as_of`; **never computed for investment or debt**, even if an opening row exists. Opening is end of `as_of`, so a flow on that day is already in the snapshot |

Reference SQL for one account's month-end savings balance, over `public`.
The mart zero-fills every account across the month list the same way.

```sql
select date_trunc('month', '<month>'::date)::date as month_start,
  a.name as account_name,
  o.amount + coalesce(sum(x.signed) filter (
    where x.occurred_on > o.as_of
      and x.occurred_on <= (date_trunc('month', '<month>'::date)
                            + interval '1 month' - interval '1 day')::date
  ), 0) as balance
from accounts as a
join account_opening_balances as o on o.account_id = a.id
left join (
  select occurred_on, to_account_id as account_id, amount as signed
  from transactions
  where type = 'transfer' and from_account_id is null and to_account_id is not null
  union all
  select occurred_on, from_account_id, -amount
  from transactions
  where type = 'transfer' and from_account_id is not null and to_account_id is null
  union all
  select occurred_on, to_account_id, amount
  from transactions
  where type = 'transfer' and from_account_id is not null and to_account_id is not null
  union all
  select occurred_on, from_account_id, -amount
  from transactions
  where type = 'transfer' and from_account_id is not null and to_account_id is not null
  union all
  select t.occurred_on, s.deposit_account_id, t.amount
  from transactions as t
  join income_sources as s on s.id = t.income_source_id
  where t.type = 'income' and s.deposit_account_id is not null
) as x on x.account_id = a.id
where a.kind = 'savings'
group by 1, a.name, o.amount, o.as_of;
```

## Adding or changing a metric

1. Add or edit its row in the metric table here, with the formula and edge
   cases, and a DECISIONS.md entry if it settles a choice.
2. Add it to the MetricFlow YAML.
3. Add the `fct_monthly_summary` column and extend the reference SQL and its
   dbt test.

CI fails if the metric names here and in the MetricFlow YAML differ, or if
`mf query` and the mart disagree for any month.
