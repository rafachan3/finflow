{#- Today in America/Toronto. Never `current_date`: the session time zone is
    UTC on CI and may be on Supabase (docs/SEMANTIC_LAYER.md). -#}
{% macro toronto_today() -%}
  (now() at time zone 'America/Toronto')::date
{%- endmacro %}
