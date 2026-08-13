-- Migration 0003: read-only role for Grafana and the Postgres MCP server.
-- The role is created WITHOUT a password; set one out of band (never in a
-- tracked file):
--   alter role finflow_readonly with password '...';

create role finflow_readonly with login;

grant usage on schema public to finflow_readonly;
grant select on all tables in schema public to finflow_readonly;

-- Tables created later (e.g. dbt models run as postgres) stay readable.
alter default privileges in schema public
  grant select on tables to finflow_readonly;
