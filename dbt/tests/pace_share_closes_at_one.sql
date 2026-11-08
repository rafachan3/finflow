-- On the last day of a month, the usual share of a month done by then is
-- 1 whenever it is not null: the last day matches each baseline month's
-- last day, whatever its length. Returns the days and series that break
-- it; the nightly checks production.
select date_day, series, pace_share_avg_3m
from {{ ref('fct_pace_day') }}
where date_day = (month_start + interval '1 month' - interval '1 day')::date
  and pace_share_avg_3m <> 1
