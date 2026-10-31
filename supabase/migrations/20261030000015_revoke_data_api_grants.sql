-- Migration 0015: the Data API roles reach nothing in the ledger.
--
-- Supabase's Data API (PostgREST at /rest/v1, pg_graphql at /graphql/v1)
-- runs each request as `anon` (the publishable/anon key alone) or
-- `authenticated` (a signed-in user's JWT). Supabase grants both roles
-- USAGE on schema public and, through default privileges, every privilege
-- on each new table, sequence and function in public. With RLS off, anyone
-- holding the project's anon key could read and write the whole ledger.
-- FinFlow never uses the Data API: the Lambda, dbt and every reader connect
-- to Postgres directly as postgres or a finflow_* role. So the fix is to
-- take the grants away, now and for objects created later.
--
-- Sources (supabase.com/docs, read 2026-10-30):
--   guides/api/securing-your-api, "Default privileges": new tables in public
--     get select, insert, update, delete, truncate, references, trigger (and
--     maintain on Postgres 17) for anon, authenticated and service_role;
--     functions get execute; sequences get usage, select, update.
--   Same page, "Revoke default privileges": `alter default privileges for
--     role postgres in schema public revoke all on tables | sequences |
--     functions from anon, authenticated, service_role`.
--   supabase/postgres, migrations/db/init-scripts/00000000000000-initial-
--     schema.sql: `grant usage on schema public to ... anon, authenticated`
--     and the same default privileges `for user supabase_admin`.
--
-- What this does, for each of anon and authenticated that exists (they do
-- not on the throwaway test Postgres, so each is guarded as 0013 guards its
-- roles; every statement is a revoke, so a rerun is a no-op):
--   1. Revokes every privilege on every table, view, sequence and routine in
--      public, and USAGE and CREATE on schemas public, staging and marts.
--      Relations in staging and marts are owned by finflow_dbt, which grants
--      them to finflow_analyst only; the migrating role cannot revoke on
--      them (Postgres refuses a REVOKE from a role holding nothing on the
--      object), and nothing else can grant on them.
--   2. Revokes the migrating role's default privileges for them, in schema
--      public and globally (a per-schema revoke cannot remove a global
--      default), so tables, sequences and functions later migrations add are
--      not granted to them again.
--   3. Does the same for objects supabase_admin creates, when the migrating
--      role may (superuser or a member of supabase_admin). On Supabase
--      `postgres` is neither, so that default stays; FinFlow's objects are
--      all created by the migrating role, and the dbt test
--      data_api_roles_reach_nothing watches production nightly either way.
--   4. Fails the migration if either role can still read or write a table
--      in public, so a revoke that did not take is not a silent success.
--
-- Not done here:
--   - RLS. Enabling it with no policies would also hide every row from
--     finflow_readonly and finflow_dbt, which read public through grants,
--     are not owners and do not bypass RLS; dbt would then build empty marts
--     and pass. Grants are the boundary (DECISIONS.md 2026-10-30).
--   - service_role. Its key is the project's secret key and bypasses RLS by
--     design; it is not a public credential.
--   - PUBLIC's execute on new functions (Supabase's fourth statement). It is
--     a global default that touches every schema; public holds no functions,
--     and without USAGE on public the Data API roles cannot call one there.
--   - Turning the Data API off in the dashboard is recommended to the owner
--     as well, but the database must not depend on that setting.
do $$
declare
  api_role text;
  owner_role text;
  reached text;
begin
  foreach api_role in array array['anon', 'authenticated'] loop
    continue when not exists (select from pg_roles where rolname = api_role);

    execute format('revoke all on all tables in schema public from %I', api_role);
    execute format('revoke all on all sequences in schema public from %I', api_role);
    execute format('revoke all on all routines in schema public from %I', api_role);
    execute format('revoke all on schema public, staging, marts from %I', api_role);

    foreach owner_role in array array[current_user::text, 'supabase_admin'] loop
      continue when not exists (select from pg_roles where rolname = owner_role)
        or not pg_has_role(current_user, owner_role, 'MEMBER');
      execute format('alter default privileges for role %I revoke all on tables from %I', owner_role, api_role);
      execute format('alter default privileges for role %I revoke all on sequences from %I', owner_role, api_role);
      execute format('alter default privileges for role %I revoke all on functions from %I', owner_role, api_role);
      execute format('alter default privileges for role %I in schema public revoke all on tables from %I', owner_role, api_role);
      execute format('alter default privileges for role %I in schema public revoke all on sequences from %I', owner_role, api_role);
      execute format('alter default privileges for role %I in schema public revoke all on functions from %I', owner_role, api_role);
    end loop;

    select c.relname into reached
    from pg_class as c
    join pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'v', 'm', 'p', 'f')
      and has_table_privilege(api_role, c.oid, 'select, insert, update, delete')
    limit 1;
    if reached is not null then
      raise exception '% can still reach public.%', api_role, reached;
    end if;
  end loop;
end $$;
