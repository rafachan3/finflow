-- Migration 0023: finflow_analyst runs with JIT off.
-- Contract: docs/DATA_MODEL.md ("Roles").
--
-- Grafana queries the stacked mart views as finflow_analyst through the
-- session pooler. With JIT on, the planner compiles those queries and they
-- took 7-10 s; with jit = off the same queries took about 0.1 s. Grafana's
-- Postgres data source has no per-connection setting, so the default lives
-- on the role. It applies to new sessions only. Idempotent.
--
-- Down: alter role finflow_analyst reset jit;

alter role finflow_analyst set jit = off;
