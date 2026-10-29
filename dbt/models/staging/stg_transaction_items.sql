-- One row per expense line, with its category, subcategory and item type
-- named. item_type_category_id is kept so a test can check the item type
-- belongs to the subcategory's category (DATA_MODEL invariant).
select
    i.id as item_id,
    i.transaction_id,
    i.description as item_description,
    i.amount,
    i.bucket::text as bucket,
    i.subcategory_id,
    sc.name as subcategory_name,
    sc.category_id,
    c.name as category_name,
    i.item_type_id,
    it.name as item_type_name,
    it.category_id as item_type_category_id
from {{ source('ledger', 'transaction_items') }} as i
join {{ source('ledger', 'subcategories') }} as sc on sc.id = i.subcategory_id
join {{ source('ledger', 'categories') }} as c on c.id = sc.category_id
left join {{ source('ledger', 'item_types') }} as it on it.id = i.item_type_id
