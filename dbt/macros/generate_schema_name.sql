{#- A model's custom schema is used as written (`staging`, `marts`), not
    prefixed with the target schema as dbt does by default. -#}
{% macro generate_schema_name(custom_schema_name, node) -%}
  {{ (custom_schema_name or target.schema) | trim }}
{%- endmacro %}
