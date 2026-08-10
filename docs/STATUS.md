# Status

Living state of the project. Read this first; update it whenever work lands.

**Last updated:** 2026-08-08
**Current phase:** Phase 0 — Repo & accounts (see [ROADMAP.md](ROADMAP.md))

## Phase progress

- [x] Planning: architecture, roadmap, and agent context written (2026-07-12)
- [ ] Phase 0 — Repo on GitHub, accounts created, MIT license, README
- [ ] Phase 1 — Supabase project, schema migrations, Notion history import
- [ ] Phase 2 — Telegram bot walking skeleton (text only, no LLM)
- [ ] Phase 3 — Gemini extraction (text → photo → voice)
- [ ] Phase 4 — dbt semantic layer
- [ ] Phase 5 — Grafana dashboards
- [ ] Phase 6 — Claude analytics agent (subagents + Postgres MCP)
- [ ] Phase 7 — Open-source polish

## What exists right now

Documentation only. No code, no database, no migrations, no deployed Worker.
The repo contains `AGENTS.md`, `CLAUDE.md`, and `docs/`.

## Next concrete step

Phase 0: create the Supabase, Cloudflare, Grafana Cloud, and Google AI Studio
accounts, register the Telegram bot with @BotFather, add an MIT `LICENSE` and a
README that points at `docs/`. Store every key in a password manager; commit
none of them.

## Open questions

- Notion export path for the history import: MCP pull vs. manual CSV export.
  Decide during Phase 1.
- Whether `merchants.aliases` is seeded by hand from the Notion tag list or
  learned from extractions over time.
- Grafana Cloud free tier's connection limits against a Supabase free project
  that pauses on inactivity — verify before building Phase 5 dashboards on it.

## Known risks

- Supabase free projects pause after ~1 week of inactivity. Daily logging plus
  the nightly dbt Action should keep it warm; confirm this empirically in
  Phase 4 rather than assuming it.
- Gemini free-tier quotas and model names change. Pin the model in code and
  record the version in `DECISIONS.md` when chosen.
