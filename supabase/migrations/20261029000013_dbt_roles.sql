-- Migration 0013: roles and schemas for the dbt semantic layer.
--   finflow_dbt     reads the ledger (public) and writes only staging/marts.
--   finflow_analyst reads marts only (Grafana, Postgres MCP).
-- Both roles are created WITHOUT a password; set them out of band (never in a
-- tracked file):
--   alter role finflow_dbt with password '...';
--   alter role finflow_analyst with password '...';
--
-- Roles are cluster-wide, so a local test cluster can already hold them from
-- another database; create each only when absent.
do $$ begin
  if not exists (select from pg_roles where rolname = 'finflow_dbt') then
    create role finflow_dbt with login;
  end if;
  if not exists (select from pg_roles where rolname = 'finflow_analyst') then
    create role finflow_analyst with login;
  end if;
end $$;

-- The migrating role owns both schemas, not finflow_dbt: dbt can build in
-- them but cannot drop them or hand them to anyone else.
create schema staging;
create schema marts;
grant usage, create on schema staging, marts to finflow_dbt;
grant usage on schema marts to finflow_analyst;

-- dbt reads the ledger and nothing more. No CREATE on public, no write on any
-- table in it.
grant usage on schema public to finflow_dbt;
grant select on all tables in schema public to finflow_dbt;
-- Tables created later by this migrating role stay readable (as in 0003).
alter default privileges in schema public
  grant select on tables to finflow_dbt;

-- Relations dbt creates in marts are owned by finflow_dbt, so the analyst's
-- SELECT needs a default privilege FOR ROLE finflow_dbt, which survives every
-- rebuild. staging gets none: the analyst never sees it.
-- ALTER DEFAULT PRIVILEGES FOR ROLE needs the migrating role to be a member of
-- finflow_dbt. A superuser (local, CI) is exempt, but Supabase's `postgres` is
-- not one, so take membership for this statement only.
grant finflow_dbt to current_user;
alter default privileges for role finflow_dbt in schema marts
  grant select on tables to finflow_analyst;
revoke finflow_dbt from current_user;
