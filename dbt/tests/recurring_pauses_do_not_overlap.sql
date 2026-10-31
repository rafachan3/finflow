-- Migration 0016: the dated pauses of one series never overlap, each being
-- [paused_from, resumed_on) with null meaning still paused. Mirrors the
-- table's exclusion constraint, so the invariant is watched even if the
-- constraint were dropped. Returns ids only.
select a.series_id, a.id as pause_id, b.id as overlapping_pause_id
from {{ source('ledger', 'recurring_pauses') }} as a
join {{ source('ledger', 'recurring_pauses') }} as b
    on b.series_id = a.series_id
   and b.id > a.id
   and daterange(a.paused_from, a.resumed_on, '[)') && daterange(b.paused_from, b.resumed_on, '[)')
