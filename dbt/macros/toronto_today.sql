{#- Today in America/Toronto. Never `current_date`: the session time zone is
    UTC on CI and may be on Supabase (docs/SEMANTIC_LAYER.md). The var
    `today` (YYYY-MM-DD) replaces it with a fixed date; only the synthetic
    fixture sets it, so its current month never moves. -#}
{% macro toronto_today() -%}
  {%- set today = var('today', '') | trim -%}
  {%- if today -%}
    {%- if not modules.re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}', today) -%}
      {{ exceptions.raise_compiler_error("var today must be YYYY-MM-DD, got " ~ today) }}
    {%- endif -%}
    date '{{ today }}'
  {%- else -%}
    (now() at time zone 'America/Toronto')::date
  {%- endif -%}
{%- endmacro %}
