-- finflow_analyst (Grafana, Postgres MCP) must default to jit = off: with JIT
-- on, the stacked mart views took 7-10 s instead of about 0.1 s (migration
-- 0023). Returns a row when the role default is missing.
select 'finflow_analyst has no jit = off role default' as problem
where not exists (
    select 1
    from pg_roles
    where rolname = 'finflow_analyst'
      and 'jit=off' = any (coalesce(rolconfig, '{}'::text[]))
)
