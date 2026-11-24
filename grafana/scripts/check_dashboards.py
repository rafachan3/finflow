"""Check the Grafana dashboards before Terraform ships them.

    python ../grafana/scripts/check_dashboards.py [dashboard.json ...]   # from dbt/

With no arguments it checks every grafana/dashboards/*.json. Three checks,
all problems reported together, exit 1 if any:

1. Structure: the JSON parses; uid, title and the `finflow` tag are set;
   every panel, target and query variable uses the `finflow-marts` data
   source; no Grafana time macro (`$__...`), so the SQL runs after plain
   variable substitution.
2. Privacy (the repo is public): no saved query results (`snapshotData`,
   `rawFrameContent`, `frames`, `dataFrames`), no TestData data source, no
   Grafana Cloud or Supabase host, nothing shaped like a Supabase project ref.
3. Query smoke: every variable query and panel query runs as
   `finflow_analyst` against the dbt fixture database (`finflow_test`, built
   by scripts/test_db.py and `dbt build`), once per value of each variable (a sample of the combinations above MAX_COMBOS),
   and returns the columns EXPECTED lists, and at least one row for some
   value. The role reads only `marts`, so a query touching another schema
   fails. Values are not checked: the dbt tests pin the marts.

Connects with the FINFLOW_DBT_HOST/PORT/DBNAME that test_db.py exports
(default localhost:5432/finflow_test) and refuses any host but this machine.
"""

import json
import re
import sys
from itertools import product
from os import environ
from pathlib import Path

import psycopg2

DASHBOARDS = Path(__file__).resolve().parents[1] / "dashboards"
DATASOURCE_UID = "finflow-marts"
ROLE = "finflow_analyst"

MEAN_TO_DATE = "Mean of previous 3 full months, by this day"

# Column names each panel's query returns, by dashboard uid and panel title.
CHANGE_COLUMNS = ["Bucket", "Last full month", "Mean of previous 3", "Change"]
LABEL_COLUMNS = ["This month so far", "Last full month", "Mean of previous 3", "Change"]
EXPECTED = {
    "finflow-month": {
        "Status": ["status"],
        "Wants left": ["label", "amount"],
        "Needs left": ["label", "amount"],
        "Income": ["label", "amount"],
        "Unallocated cash": ["label", "amount"],
        "Buckets vs targets": ["Bucket", "So far", "% of income", "Target", "Status"],
        "Wants by day": ["Day", "This month", "This month, above the mean", MEAN_TO_DATE,
                         "Wants target for the month"],
        "Everyday needs by day": ["Day", "This month", "This month, above the mean", MEAN_TO_DATE],
        "Where wants went this month": ["category", "This month so far", MEAN_TO_DATE,
                                        "Mean of previous 3 full months, whole month"],
        "Recurring and one-off spending": ["label", "amount"],
        "Largest purchases this month": ["Date", "Item", "Category", "Bucket", "Amount"],
        "Wants by subcategory this month": [
            "Category", "Subcategory", "This month", "Usual by this day", "Change"],
    },
    "finflow-trends": {
        "Recurring and one-off spending by month": ["month", "Recurring", "One-off"],
        "Top merchants, last 3 full months": ["Merchant", "Spent", "Per month", "Purchases"],
        "Largest purchases, last 3 full months": [
            "Date", "Item", "Category", "Bucket", "Amount"],
        "Income and where it went": ["time", "Needs", "Wants", "Financial future", "Income", "Income so far"],
        "Months in numbers": [
            "Month", "Income", "Needs", "Wants", "Financial future", "Unallocated"],
        "Wants by category and month": ["month", "category", "spend"],
        "Needs by category and month": ["month", "category", "spend"],
        "Biggest changes last month, by category": ["Category", *CHANGE_COLUMNS],
        "Biggest changes last month, by subcategory": ["Category", "Subcategory", *CHANGE_COLUMNS],
        "Average bucket shares": ["Period", "Needs", "Wants", "Financial future", "Unallocated"],
        "Recurring commitments": ["Series", "Cadence", "Bucket", "Latest amount", "Last paid", "Months of 3"],
        "Wants by weekday": ["weekday", "Mean wants per day"],
        "Wants by days since pay": ["Days since pay", "Mean wants per day"],
        "Spent through apps per month": ["month", "Through apps"],
    },
    "finflow-ledger": {
        "Selection by merchant": ["Merchant", "Spent", "Purchases"],
        "Selection by venue": ["Venue", "Spent", "Purchases"],
        "Selection by channel": ["Channel", "Spent", "Purchases"],
        "Income and transfers": ["Date", "Type", "From or to", "Amount"],
        "This selection": ["Spent", "Per month", "Line items"],
        "By category": ["Category", "Spent", "Per month", "Line items", "Share", "Change"],
        "By subcategory": ["Subcategory", "Category", "Spent", "Per month", "Line items", "Share",
                           "Change"],
        "Selection by month": ["month", "Spent"],
        "Line items": [
            "Date", "Item", "Merchant", "Venue", "Channel", "Category", "Subcategory", "Bucket",
            "Amount", "Tags", "Paid by", "Note"],
    },
    "finflow-labels": {
        "Tags": ["Tag", *LABEL_COLUMNS],
        "What each tag was spent on": ["Tag", "Category", "Per month", "Share"],
        "${tag_r}": ["month", "Spent"],
        "Merchants": ["Merchant", *LABEL_COLUMNS],
        "What you bought at each merchant": ["Merchant", "Subcategory", "Per month", "Share"],
        "${merchant_r}": ["month", "Spent"],
        "Channels": ["Channel", *LABEL_COLUMNS],
        "What you bought through each channel": ["Channel", "Subcategory", "Per month", "Share"],
        "${channel_r}": ["month", "Spent"],
    },
    "finflow-income": {
        "Last full month": ["Income", "Mean, last 3 full months", "Financial future", "Set aside",
                            "Target"],
        "Income by source": ["time", "metric", "value"],
        "Income sources, last 6 full months": [
            "Source", "Last full month", "Monthly mean", "Share", "Months received",
            "Last received"],
        "Financial future by kind of account": [
            "time", "Savings", "Investments", "Debt paid down", "Target"],
        "Financial future in numbers": [
            "Month", "Moved in", "Taken out", "Net", "Target", "Set aside"],
        "Income this lifestyle needs": [
            "Period", "Needs a month", "Wants a month", "Income needed", "Income you had",
            "Spare", "Set by"],
        "Set aside since tracking began": ["time", "metric", "value"],
    },
    "finflow-reliance": {
        "Last full month": ["Paid by others", "Share of what was bought", "Support income",
                            "Share of income"],
        "Who paid, by month": ["month", "You", "Others"],
        "What others paid for, last 6 full months": [
            "Category", "Paid by others a month", "Share of the category"],
        "Income by month, support and the rest": ["month", "Other income", "Support income"],
        "Support income by period": [
            "Period", "Income a month", "Support a month", "Share of income",
            "Financial future", "Without support"],
        "Bucket shares with and without support income": [
            "Bucket", "A month", "As logged", "Without support", "Target"],
        "Income this lifestyle needs, counting what others paid": [
            "Period", "Needs a month", "Wants a month", "Income needed",
            "Income without support", "Spare", "Set by"],
    },
}
VARIABLE_COLUMNS = ["__value", "__text"]
# Above this many variable combinations a dashboard is sampled (see smoke()).
MAX_COMBOS = 500

SAVED_DATA_KEYS = {"snapshotData", "rawFrameContent", "frames", "dataFrames"}
HOSTS = re.compile(r"grafana\.net|supabase\.com|supabase\.co\b", re.I)
# A Supabase project ref is 20 lowercase letters.
PROJECT_REF = re.compile(r"(?<![A-Za-z0-9])[a-z]{20}(?![A-Za-z0-9])")
VARIABLE = re.compile(r"\$\{(\w+)(?::(\w+))?\}|\$(\w+)|\[\[(\w+)\]\]")


def walk(node, path="$"):
    """Every (path, key, value) in the JSON tree."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield path, k, v
            yield from walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}[{i}]")


def is_testdata(ds):
    text = json.dumps(ds).lower() if ds is not None else ""
    return "testdata" in text


def panels(dash):
    for p in dash.get("panels", []):
        yield p
        yield from p.get("panels", [])  # panels inside a collapsed row


def privacy(name, raw, dash):
    problems = []
    for path, key, value in walk(dash):
        if key in SAVED_DATA_KEYS:
            problems.append(f"{name}: saved query data at {path}.{key}")
        if key == "datasource" and is_testdata(value):
            problems.append(f"{name}: TestData data source at {path}")
    if HOSTS.search(raw):
        problems.append(f"{name}: names a Grafana Cloud or Supabase host")
    if PROJECT_REF.search(raw):
        problems.append(f"{name}: holds a string shaped like a Supabase project ref")
    return problems


def datasource_ok(ds):
    return isinstance(ds, dict) and ds.get("uid") == DATASOURCE_UID


def structure(name, dash):
    """Problems, plus the queries to run: (label, sql, expected columns)."""
    problems, queries = [], []
    uid = dash.get("uid")
    for field in ("uid", "title"):
        if not dash.get(field):
            problems.append(f"{name}: no {field}")
    if "finflow" not in dash.get("tags", []):
        problems.append(f"{name}: no finflow tag")
    expected = EXPECTED.get(uid)
    if expected is None:
        problems.append(f"{name}: dashboard {uid} has no EXPECTED columns in check_dashboards.py")
        expected = {}

    for var in dash.get("templating", {}).get("list", []):
        if var.get("type") != "query":
            continue
        label = f"{name}: variable {var.get('name')}"
        if not datasource_ok(var.get("datasource")):
            problems.append(f"{label} does not use data source {DATASOURCE_UID}")
        sql = var.get("query")
        sql = sql.get("rawSql") or sql.get("query") if isinstance(sql, dict) else sql
        queries.append((label, sql or "", VARIABLE_COLUMNS))

    titles = set()
    for p in panels(dash):
        if p.get("type") == "row":
            continue
        title = p.get("title", "")
        titles.add(title)
        label = f"{name}: panel {title!r}"
        if not datasource_ok(p.get("datasource")):
            problems.append(f"{label} does not use data source {DATASOURCE_UID}")
        targets = p.get("targets", [])
        if not targets:
            problems.append(f"{label} has no query")
        for t in targets:
            if not datasource_ok(t.get("datasource")):
                problems.append(f"{label} has a target that does not use data source {DATASOURCE_UID}")
            if not t.get("rawSql"):
                problems.append(f"{label} has a target with no rawSql")
                continue
            if title not in expected:
                problems.append(f"{label} has no EXPECTED columns in check_dashboards.py")
                continue
            queries.append((label, t["rawSql"], expected[title]))
    for title in sorted(set(expected) - titles):
        problems.append(f"{name}: EXPECTED lists panel {title!r}, which the dashboard lacks")

    for label, sql, _ in queries:
        if "$__" in sql:
            problems.append(f"{label} uses a Grafana macro ($__...); filter on variables instead")
    return problems, queries


def quote(value, fmt):
    """Grafana's interpolation of one single-valued variable for a SQL data source."""
    escaped = value.replace("'", "''")
    if fmt is None:
        return escaped
    if fmt == "sqlstring":
        return f"'{escaped}'"
    if fmt == "raw":
        return value
    raise ValueError(f"format :{fmt} is not handled by check_dashboards.py")


def substitute(sql, values):
    def one(m):
        name = m.group(1) or m.group(3) or m.group(4)
        if name not in values:
            raise KeyError(name)
        return quote(values[name], m.group(2))

    return VARIABLE.sub(one, sql)


def connect():
    host = environ.get("FINFLOW_DBT_HOST", "localhost")
    if host not in ("localhost", "127.0.0.1"):
        sys.exit(f"check_dashboards: refuses host {host}; it runs only against the local fixture")
    db = psycopg2.connect(host=host, port=int(environ.get("FINFLOW_DBT_PORT", "5432")),
                          dbname=environ.get("FINFLOW_DBT_DBNAME", "finflow_test"),
                          # No session settings beyond a timeout: the role's own defaults
                          # (jit = off, migration 0023) apply, as they do for Grafana.
                          user=ROLE, password=ROLE, options="-c statement_timeout=10000")
    db.set_session(readonly=True, autocommit=True)
    return db


def run(cur, sql):
    """(columns, row count) or the error's first line."""
    try:
        cur.execute(sql)
    except psycopg2.Error as err:
        return None, str(err).strip().splitlines()[0]
    return [d.name for d in cur.description], cur.rowcount


def variable_values(cur, name, dash, queries):
    """The values to try for each variable: what its query returns, or its options."""
    values = {}
    for var in dash.get("templating", {}).get("list", []):
        vname = var.get("name")
        if var.get("type") == "query":
            # Its own errors are reported when smoke() runs it with the panels.
            sql = next(q for label, q, _ in queries if label == f"{name}: variable {vname}")
            try:
                cur.execute(substitute(sql, {}))
                values[vname] = [str(r[0]) for r in cur.fetchall()]
            except (psycopg2.Error, KeyError, ValueError):
                values[vname] = []
        elif var.get("type") == "textbox":
            # Its default, and a date: a text box may be a search or a day.
            values[vname] = [var.get("query", ""), "2000-01-01"]
        elif var.get("type") == "custom":
            values[vname] = [o["value"] for o in var.get("options", [])]
        else:
            values[vname] = None
    return values


def smoke(cur, name, dash, queries):
    problems = []
    values = variable_values(cur, name, dash, queries)
    for vname, vals in values.items():
        if vals is None:
            problems.append(f"{name}: variable {vname}'s type has no test values in check_dashboards.py")
        elif not vals:
            problems.append(f"{name}: variable {vname} has no values on the fixture")
    if problems:
        # Still run the variable queries, so a broken one reports its error.
        queries = [q for q in queries if ": variable " in q[0]]
        values = {}
    names = sorted(values)
    combos = [dict(zip(names, c)) for c in product(*(values[n] for n in names))] or [{}]
    if len(combos) > MAX_COMBOS:
        # Too many to run them all: an even sample of the product, plus every
        # value of every variable once against the first combination.
        sample = combos[:: len(combos) // MAX_COMBOS]
        singles = [{**combos[0], n: v} for n in names for v in values[n]]
        combos = sample + [c for c in singles if c not in sample]
    ran = 0
    for label, sql, expected in queries:
        rows = 0
        for combo in combos:
            try:
                text = substitute(sql, combo)
            except KeyError as missing:
                problems.append(f"{label} uses ${missing.args[0]}, which is not a dashboard variable")
                break
            except ValueError as err:
                problems.append(f"{label}: {err}")
                break
            columns, result = run(cur, text)
            ran += 1
            if columns is None:
                at = ", ".join(f"{k}={v}" for k, v in combo.items())
                problems.append(f"{label} fails as {ROLE} ({at}): {result}")
                break
            if columns != expected:
                problems.append(f"{label} returns columns {columns}, expected {expected}")
                break
            rows += result
        else:
            if rows == 0:
                problems.append(f"{label} returns no rows for any value of its variables")
    return problems, ran


def main(paths):
    files = [Path(p) for p in paths] or sorted(DASHBOARDS.glob("*.json"))
    problems, checked, loaded = [], 0, []
    for f in files:
        raw = f.read_text()
        try:
            dash = json.loads(raw)
        except json.JSONDecodeError as err:
            problems.append(f"{f.name}: not JSON: {err}")
            continue
        found, queries = structure(f.name, dash)
        problems += privacy(f.name, raw, dash) + found
        loaded.append((f.name, dash, queries))
    if loaded:
        db = connect()
        with db.cursor() as cur:
            for name, dash, queries in loaded:
                found, ran = smoke(cur, name, dash, queries)
                problems += found
                checked += ran
        db.close()
    for p in problems:
        print(f"check_dashboards: {p}")
    if problems:
        sys.exit(1)
    print(f"check_dashboards: {len(loaded)} dashboard(s) clean, {checked} queries ran as {ROLE}")


if __name__ == "__main__":
    main(sys.argv[1:])
