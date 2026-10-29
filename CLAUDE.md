@AGENTS.md

Everything above applies. The rules below are Claude Code-specific and take
priority over the import where they overlap.

## Session protocol

- Read `CLAUDE.local.md` if it exists — it
  carries owner-specific identifiers that are deliberately untracked.
- When work lands, update `docs/STATUS.md`, and append to `docs/DECISIONS.md`
  if a choice was made that a future session would otherwise re-litigate.
  Do this in the same turn as the work, not "later" — it does not survive
  `/compact`.

## Agent layer

Phase 6 will add a Postgres MCP server on a read-only Supabase role; never point
MCP at a role that can write.
