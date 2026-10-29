-- A line's item type, when set, belongs to the same category as its
-- subcategory (DATA_MODEL invariant, "dbt test").
select item_id
from {{ ref('stg_transaction_items') }}
where item_type_id is not null
  and item_type_category_id <> category_id
