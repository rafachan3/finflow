"""Report the warn-level dbt tests of the last build, as public-safe Markdown.

    python scripts/ledger_health.py          # from dbt/, after `dbt build`

Reads target/run_results.json and prints a table of every test that warned
with its row count, then the ids each ID_TESTS test returned (it reruns
that test's compiled SQL with the FINFLOW_DBT_* connection profiles.yml
uses). Prints nothing when no test warned. The nightly posts this to a
public job summary and issue, so it prints test names, counts and ids
only: any value that is not a UUID is withheld.
"""

import json
import re
import sys
from os import environ
from pathlib import Path

import psycopg2

# Tests whose rows are transaction ids only, so they can be listed.
ID_TESTS = ("no_likely_duplicates", "recurring_flag_has_series")
MAX_ROWS = 50
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TARGET = Path(__file__).resolve().parents[1] / "target"


def connect():
    return psycopg2.connect(
        host=environ.get("FINFLOW_DBT_HOST", "localhost"),
        port=int(environ.get("FINFLOW_DBT_PORT", "54329")),
        user=environ.get("FINFLOW_DBT_USER", "finflow_dbt"),
        password=environ.get("FINFLOW_DBT_PASSWORD", ""),
        dbname=environ.get("FINFLOW_DBT_DBNAME", "postgres"),
        sslmode=environ.get("FINFLOW_DBT_SSLMODE", "disable"),
    )


def safe(value):
    text = str(value)
    return f"`{text}`" if UUID.match(text) else "(withheld)"


def main():
    results = json.loads((TARGET / "run_results.json").read_text())["results"]
    warned = {
        r["unique_id"].removeprefix("test.finflow."): r.get("failures") or 0
        for r in results
        if r["unique_id"].startswith("test.") and r["status"] == "warn"
    }
    if not warned:
        return
    print("| Warning | Rows |")
    print("|---|---|")
    for name, count in sorted(warned.items()):
        print(f"| `{name}` | {count} |")
    listed = [n for n in ID_TESTS if n in warned]
    if not listed:
        return
    db = connect()
    with db.cursor() as cur:
        for name in listed:
            sql = (TARGET / "compiled" / "finflow" / "tests" / f"{name}.sql").read_text()
            # Sorted, so an unchanged ledger gives the same report each night.
            cur.execute(f"select * from ({sql}) as t order by t limit {MAX_ROWS}")
            print(f"\n`{name}`:")
            for row in cur.fetchall():
                print("- " + " and ".join(safe(v) for v in row))
            if warned[name] > MAX_ROWS:
                print(f"- and {warned[name] - MAX_ROWS} more")
    db.close()


if __name__ == "__main__":
    sys.exit(main())
