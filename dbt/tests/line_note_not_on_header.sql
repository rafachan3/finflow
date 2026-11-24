-- A line note never repeats its transaction's note (the application's
-- canonicalNotes rule). Warn only: a repeat changes no number.
{{ config(severity='warn') }}
select line_key
from {{ ref('fct_transactions') }}
where item_note = notes
