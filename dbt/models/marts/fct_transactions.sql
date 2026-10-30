-- One row per ledger line (docs/SEMANTIC_LAYER.md, "Grain"): one per
-- expense line, plus one per income or transfer transaction, whose header
-- stands in for its own line. line_key is the line's id or the
-- transaction's (both uuids, so they never collide). amount sums back to
-- transactions.amount per transaction, so every contract metric is a
-- filtered sum(amount) over this table. A null account name is chequing:
-- deposit_account_name (income), from_account_name and to_account_name
-- (transfers).
with lines as (
    select
        item_id as line_key,
        transaction_id,
        item_id,
        amount,
        item_description,
        category_name,
        subcategory_id,
        subcategory_name,
        item_type_name,
        bucket
    from {{ ref('stg_transaction_items') }}

    union all

    select
        transaction_id,
        transaction_id,
        null,
        amount,
        null,
        null,
        null,
        null,
        null,
        null
    from {{ ref('stg_transactions') }}
    where type <> 'expense'
),

-- Effective tags: the line's own plus its transaction's, distinct, sorted.
tags as (
    select line_key, array_agg(distinct tag_name order by tag_name) as tags
    from {{ ref('stg_item_tags') }}
    group by line_key
)

select
    l.line_key,
    l.transaction_id,
    l.item_id,
    t.occurred_on,
    t.month_start,
    t.type,
    l.amount,
    t.amount as transaction_amount,
    t.currency,
    t.description,
    l.item_description,
    t.notes,
    l.category_name,
    l.subcategory_id,
    l.subcategory_name,
    l.item_type_name,
    l.bucket,
    t.is_recurring,
    t.funding_source_name,
    case when t.type = 'expense' then t.funding_source_name = 'self' end as is_self_funded,
    t.merchant_name,
    t.venue_name,
    t.income_source_name,
    t.deposit_account_name,
    t.from_account_name,
    t.from_account_kind,
    t.to_account_name,
    t.account_kind,
    t.entry_source,
    coalesce(g.tags, '{}'::text[]) as tags
from lines as l
join {{ ref('stg_transactions') }} as t on t.transaction_id = l.transaction_id
left join tags as g on g.line_key = l.line_key
