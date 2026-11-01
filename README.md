# FinFlow

Self-hosted personal finance pipeline: Telegram bot → LLM extraction →
Postgres → dbt → dashboards + an analytics agent. Built to stay under
**$1/month** on durable free tiers.

## Start here

| Doc | What it is |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | Current phase, what’s done, what’s next |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phases and acceptance checks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design and component choices |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Schema contract |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why we chose what we chose |
| [AGENTS.md](AGENTS.md) | Constraints and conventions for agents |

## How the numbers are made

The bot writes one row per purchase or payment into Postgres. That raw
ledger is hard to chart directly, so the numbers go through three steps:

- **dbt** (a tool that runs SQL files in order) turns the ledger rows into
  tidy summary tables called *marts*, and runs automatic tests on them. It
  runs on every pull request against a throwaway database, and nightly
  against production.
- **MetricFlow** (dbt's metric layer) defines each metric, such as spend or
  savings, once. A chart or the analytics agent asks for the metric by name,
  so it cannot compute its own, different version.
- **The contract** is [docs/SEMANTIC_LAYER.md](docs/SEMANTIC_LAYER.md): the
  written definition of every metric. If a model disagrees with it, the
  model is wrong.

Each night a check recomputes every metric from the raw tables and fails if
the marts or MetricFlow disagree with each other or with the contract. A
failing night opens a GitHub issue naming what failed, never the amounts
(the log is public). See [docs/TESTING.md](docs/TESTING.md), "The nightly
dbt build".

**Example (invented numbers).** One month, with the default 50/30/20 split:

| Ledger rows that month | Amount |
|---|---|
| Paycheques into chequing | 4,000 |
| Rent and groceries (needs) | 1,900 |
| Eating out and games (wants) | 1,100 |
| Moved from chequing to a savings account | 600 |

Those become the four monthly lines: **needs** 1,900 (47.5%, target 50%),
**wants** 1,100 (27.5%, target 30%), **financial future** 600 (15%, target
20%; money actually moved to savings, investments or debt) and **still in
chequing** 400 (10%; what is left). They add back to the 4,000 that arrived.
Definitions: [docs/SEMANTIC_LAYER.md](docs/SEMANTIC_LAYER.md).

## License

MIT — see [LICENSE](LICENSE).
