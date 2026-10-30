-- After a rebuild, finflow_analyst (Grafana, Postgres MCP) can still read
-- every mart: USAGE on the schema and SELECT on each relation in it, which
-- migration 0013's default privilege grants as dbt creates them. Returns
-- what it cannot read. The refs make this run after the marts are rebuilt;
-- a relation added to marts later is caught by the catalog scan.
{% set marts = [ref('dim_date'), ref('fct_transactions'), ref('fct_category_month'), ref('fct_monthly_summary')] %}

select 'schema ' || '{{ marts[0].schema }}' as unreadable
where not has_schema_privilege('finflow_analyst', '{{ marts[0].schema }}', 'USAGE')

{% for mart in marts %}
union all
select '{{ mart.identifier }}'
where not has_table_privilege('finflow_analyst', '{{ mart }}', 'SELECT')
{% endfor %}

union all
select c.relname
from pg_class as c
join pg_namespace as n on n.oid = c.relnamespace
where n.nspname = '{{ marts[0].schema }}'
  and c.relkind in ('r', 'v', 'm', 'p')
  and not has_table_privilege('finflow_analyst', c.oid, 'SELECT')
