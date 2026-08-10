@AGENTS.md

Everything above applies. The rules below are Claude Code-specific and take
priority over the import where they overlap.

## Session protocol

- Read `docs/STATUS.md` before acting. Read `CLAUDE.local.md` if it exists — it
  carries owner-specific identifiers that are deliberately untracked.
- When work lands, update `docs/STATUS.md`, and append to `docs/DECISIONS.md`
  if a choice was made that a future session would otherwise re-litigate.
  Do this in the same turn as the work, not "later" — it does not survive
  `/compact`.

## Agent layer

- `.mcp.json` configures a Postgres MCP server against a **read-only** Supabase
  role. Never point MCP at a role that can write.
- Subagents in `.claude/agents/`: `data-analyst`, `sql-runner`, `spend-coach`.
  Analytics questions go to a subagent, not to ad-hoc SQL in the main session.
- Any number an agent reports must trace to a dbt mart and a definition in
  `docs/SEMANTIC_LAYER.md`. If a metric is not defined there, define it there
  first, then query.
