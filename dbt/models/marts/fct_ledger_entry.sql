-- One row per transaction header (docs/SEMANTIC_LAYER.md, "Grain" and
-- "Listing marts"). A listing for the Ledger dashboard, not a metric: no
-- MetricFlow model, and fct_monthly_summary is not summed from this.
-- Nested line items stay on fct_transactions, joined on transaction_id.
-- Built from staging so a line-grain change cannot reshape the listing.
with lines as (
    select
        transaction_id,
        count(*)::integer as line_count,
        coalesce(sum(amount) filter (where bucket = 'needs'), 0)
            ::numeric(12, 2) as needs_amount,
        coalesce(sum(amount) filter (where bucket = 'wants'), 0)
            ::numeric(12, 2) as wants_amount
    from {{ ref('stg_transaction_items') }}
    group by 1
),

-- Distinct category › subcategory paths, largest line in that path first.
paths as (
    select
        transaction_id,
        array_agg(path order by max_amount desc, path) as subcategory_paths,
        count(*)::integer as path_count
    from (
        select
            transaction_id,
            category_name || ' › ' || subcategory_name as path,
            max(amount) as max_amount
        from {{ ref('stg_transaction_items') }}
        group by 1, 2
    ) as p
    group by 1
),

-- The path of the largest line; ties break on names then item_id.
primary_path as (
    select distinct on (transaction_id)
        transaction_id,
        category_name || ' › ' || subcategory_name as path
    from {{ ref('stg_transaction_items') }}
    order by transaction_id, amount desc, category_name, subcategory_name, item_id
),

-- Union of header tags and line tags, distinct, sorted.
tags as (
    select
        transaction_id,
        array_agg(distinct tag_name order by tag_name) as tags
    from {{ ref('stg_item_tags') }}
    group by 1
)

select
    t.transaction_id,
    t.occurred_on,
    t.month_start,
    t.type,
    t.amount,
    t.description,
    t.notes,
    t.merchant_name,
    t.venue_name,
    t.income_source_name,
    t.from_account_name,
    t.to_account_name,
    case t.type
        when 'income' then t.income_source_name
        when 'transfer' then
            coalesce(t.from_account_name, 'Chequing')
            || ' → '
            || coalesce(t.to_account_name, 'Chequing')
        when 'expense' then
            case
                when t.merchant_name is not null and t.venue_name is not null
                    then t.merchant_name || ' · ' || t.venue_name
                else coalesce(t.merchant_name, t.venue_name)
            end
    end as counterparty,
    t.funding_source_name,
    case when t.type = 'expense' then t.funding_source_name = 'self' end
        as is_self_funded,
    coalesce(l.line_count, 0) as line_count,
    case
        when p.path_count > 1
            then prim.path || ' +' || (p.path_count - 1)::text
        else prim.path
    end as category_summary,
    coalesce(p.subcategory_paths, '{}'::text[]) as subcategory_paths,
    case
        when t.type <> 'expense' then null
        when coalesce(l.needs_amount, 0) > 0
             and coalesce(l.wants_amount, 0) > 0 then 'mixed'
        when coalesce(l.needs_amount, 0) > 0 then 'needs'
        when coalesce(l.wants_amount, 0) > 0 then 'wants'
    end as bucket_summary,
    coalesce(l.needs_amount, 0) as needs_amount,
    coalesce(l.wants_amount, 0) as wants_amount,
    coalesce(g.tags, '{}'::text[]) as tags,
    t.is_recurring,
    t.recurring_series_name,
    t.recurring_cadence,
    t.entry_source
from {{ ref('stg_transactions') }} as t
left join lines as l on l.transaction_id = t.transaction_id
left join paths as p on p.transaction_id = t.transaction_id
left join primary_path as prim on prim.transaction_id = t.transaction_id
left join tags as g on g.transaction_id = t.transaction_id
