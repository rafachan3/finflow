# Docs index

Two kinds of file live here. Read the first kind to understand or run the
project. Treat the second kind as history.

## Reader docs

| File | What it is |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together, and why each was chosen |
| [DATA_MODEL.md](DATA_MODEL.md) | The database schema; also explains the untracked seed overlay |
| [SEMANTIC_LAYER.md](SEMANTIC_LAYER.md) | The contract: what every metric means and how it is computed |
| [TAXONOMY.md](TAXONOMY.md) | The category and item-type lists, and the rules for classifying a purchase |
| [ROADMAP.md](ROADMAP.md) | The phases and the check that decides each one is done |

### Your own private overrides

To run your own copy, keep your personal values out of version control:

- A seed overlay: an untracked SQL file that loads your accounts, income
  sources and targets. Start from the tracked example,
  `supabase/seed.personal.example.sql`.
- A bucket rules file: an untracked Markdown file with your own rules for
  what counts as a need or a want. [TAXONOMY.md](TAXONOMY.md) says how it is
  used.

Both are your own untracked overlay files; the repo works without them and
never contains them.

## Working logs

These record what was done and decided, dated, as the work happened. They are
history, not how-tos: do not follow them as instructions.

| File | What it is |
|---|---|
| [STATUS.md](STATUS.md) | Where the last session stopped; a new session picks up here |
| [DECISIONS.md](DECISIONS.md) | Dated decisions and the options they ruled out |
| [TESTING.md](TESTING.md) | Which test guards which behaviour, and how to run each test layer |

## Rule for contributors and agents

Nothing personal goes in tracked docs, issues or pull requests: no names,
amounts, account details, tokens or IDs. Use invented examples instead.
