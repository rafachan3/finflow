"""Hold the MetricFlow metrics to the contract and to the monthly mart.

    python scripts/check_metrics.py   # from dbt/, after dbt build

1. The metric names in docs/SEMANTIC_LAYER.md's metric table and in
   target/semantic_manifest.json must be the same set.
2. `mf query` runs every metric by metric_time__month over the mart's months.
3. Every metric of every month must equal marts.fct_monthly_summary: money
   to the cent, a ratio within 0.0001. A month or cell mf leaves empty is 0
   for money and null for a ratio.

A mismatch prints the metric and the month, never a value: CI logs are
public. Connects with the FINFLOW_DBT_* variables profiles.yml reads.
"""

import csv
import json
import re
import subprocess
import sys
import tempfile
from decimal import Decimal
from os import environ
from pathlib import Path

import psycopg2

DBT = Path(__file__).resolve().parents[1]
CONTRACT = DBT.parent / "docs" / "SEMANTIC_LAYER.md"
RATIOS = {"savings_rate", "needs_wants_ratio"}
RATIO_TOLERANCE = Decimal("0.0001")
CENT = Decimal("0.01")


def contract_metrics():
    """Rows of the metric table whose first cell is a backticked name."""
    section = CONTRACT.read_text().split("\n## Metrics\n", 1)[1].split("\n#", 1)[0]
    return set(re.findall(r"^\| `([a-z_]+)` \|", section, re.M))


def manifest_metrics():
    manifest = json.loads((DBT / "target" / "semantic_manifest.json").read_text())
    return {m["name"] for m in manifest["metrics"]}


def mart_months(names):
    db = psycopg2.connect(
        host=environ.get("FINFLOW_DBT_HOST", "localhost"),
        port=environ.get("FINFLOW_DBT_PORT", "54329"),
        user=environ.get("FINFLOW_DBT_USER", "finflow_dbt"),
        password=environ.get("FINFLOW_DBT_PASSWORD", ""),
        dbname=environ.get("FINFLOW_DBT_DBNAME", "postgres"),
        sslmode=environ.get("FINFLOW_DBT_SSLMODE", "disable"),
    )
    with db, db.cursor() as cur:
        # names passed the contract regex, so they are plain identifiers.
        cur.execute(f"select month_start, {', '.join(names)} from marts.fct_monthly_summary")
        rows = cur.fetchall()
    db.close()
    return {str(r[0]): dict(zip(names, r[1:])) for r in rows}


def mf_months(names, first, last):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "mf.csv"
        run = subprocess.run(
            # The mf installed next to this interpreter, so a venv needs no PATH.
            [Path(sys.executable).parent / "mf", "query", "--metrics", ",".join(names), "--group-by", "metric_time__month",
             "--start-time", first, "--end-time", last, "--csv", str(out)],
            cwd=DBT, capture_output=True, text=True,
        )
        if run.returncode != 0:
            sys.exit(f"mf query failed (exit {run.returncode}):\n{run.stderr[-2000:]}")
        with out.open() as f:
            rows = list(csv.DictReader(f))
    return {
        r["metric_time__month"][:10]: {n: Decimal(r[n]) if r[n] else None for n in names}
        for r in rows
    }


def mismatches(names, mart, mf):
    """(metric, month) pairs that disagree; mf months the mart lacks fail too."""
    bad = [("every metric", m) for m in sorted(set(mf) - set(mart))]
    for month in sorted(mart):
        for name in names:
            want, got = mart[month][name], mf.get(month, {}).get(name)
            if name in RATIOS:
                same = (want is None and got is None) or (
                    want is not None and got is not None and abs(want - got) <= RATIO_TOLERANCE
                )
            else:
                same = want == (got or Decimal(0)).quantize(CENT)
            if not same:
                bad.append((name, month))
    return bad


def main():
    contract, manifest = contract_metrics(), manifest_metrics()
    if contract != manifest:
        for name in sorted(manifest - contract):
            print(f"metric {name} is in the MetricFlow YAML but not in SEMANTIC_LAYER.md")
        for name in sorted(contract - manifest):
            print(f"metric {name} is in SEMANTIC_LAYER.md but not in the MetricFlow YAML")
        sys.exit(1)
    names = sorted(contract)
    mart = mart_months(names)
    mf = mf_months(names, min(mart), max(mart))
    bad = mismatches(names, mart, mf)
    for name, month in bad:
        print(f"mf query and fct_monthly_summary differ: {name}, {month[:7]}")
    if bad:
        sys.exit(1)
    print(f"mf query matches fct_monthly_summary: {len(names)} metrics, {len(mart)} months")


if __name__ == "__main__":
    main()
