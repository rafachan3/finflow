-- A line tag never repeats its transaction's header tag (the application's
-- canonicalTags rule). Warn only: the effective-tag aggregate is distinct,
-- so a repeat changes no number.
{{ config(severity='warn') }}
select line_key, tag_name
from {{ ref('stg_item_tags') }}
group by line_key, tag_name
having count(*) > 1
