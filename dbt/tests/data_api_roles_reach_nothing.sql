-- Supabase's Data API roles, anon and authenticated, reach nothing in public,
-- staging or marts: no grant on the schemas, no privilege on any relation,
-- sequence or routine in them, and no default privilege of the role that owns
-- the ledger handing them new ones (migration 0015). Returns role, object
-- and privilege names, never a row of data. Where the roles do not exist (the
-- throwaway test Postgres) it returns nothing; the nightly runs it on
-- production. Schema and routine grants are read from the ACLs: Postgres
-- gives PUBLIC USAGE on schema public and EXECUTE on new functions, which
-- every role inherits and which 0015 leaves alone.
with api_role as (
    select oid, rolname from pg_roles where rolname in ('anon', 'authenticated')
),

watched as (
    select oid, nspname, nspacl from pg_namespace
    where nspname in ('public', 'staging', 'marts')
),

ledger_owner as (
    select relowner as oid from pg_class where oid = 'public.transactions'::regclass
)

select r.rolname as api_role, 'schema ' || s.nspname as object, a.privilege_type as privilege
from watched as s
cross join lateral aclexplode(s.nspacl) as a
join api_role as r on r.oid = a.grantee

union all

select r.rolname, s.nspname || '.' || c.relname, a.privilege_type
from pg_class as c
join watched as s on s.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) as a
join api_role as r on r.oid = a.grantee

-- Effective access, which also counts column grants and grants to PUBLIC.
union all

select r.rolname, s.nspname || '.' || c.relname, 'read or write'
from pg_class as c
join watched as s on s.oid = c.relnamespace
cross join api_role as r
where c.relkind in ('r', 'v', 'm', 'p', 'f')
  and (has_any_column_privilege(r.oid, c.oid, 'select, insert, update, references')
       or has_table_privilege(r.oid, c.oid, 'delete, truncate'))

union all

select r.rolname, s.nspname || '.' || c.relname, 'sequence'
from pg_class as c
join watched as s on s.oid = c.relnamespace
cross join api_role as r
where c.relkind = 'S'
  and has_sequence_privilege(r.oid, c.oid, 'usage, select, update')

union all

select r.rolname, s.nspname || '.' || p.proname, a.privilege_type
from pg_proc as p
join watched as s on s.oid = p.pronamespace
cross join lateral aclexplode(p.proacl) as a
join api_role as r on r.oid = a.grantee

union all

-- defaclobjtype: r tables, S sequences, f functions.
select r.rolname, 'default ' || d.defaclobjtype::text || ' in ' || coalesce(s.nspname, 'every schema'), a.privilege_type
from pg_default_acl as d
join ledger_owner as o on o.oid = d.defaclrole
left join watched as s on s.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) as a
join api_role as r on r.oid = a.grantee
where d.defaclnamespace = 0 or s.oid is not null
