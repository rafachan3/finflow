"""Rebuild the throwaway ledger dbt runs against, then print its connection.

    eval "$(python scripts/test_db.py [extra.sql ...])"   # from dbt/

Reads TEST_DATABASE_URL and refuses any host but this machine. Builds the
`finflow_test` database the way lambda/tests/integration/global-setup.ts
does (every migration in order, then the example seed), loads
fixtures/synthetic.sql and then each extra file, gives finflow_dbt a
throwaway password, and prints the FINFLOW_DBT_* exports profiles.yml
reads. It shares the integration suite's database, so running either
rebuilds it for that one.
"""

import shlex
import sys
from os import environ
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import psycopg2

DBT = Path(__file__).resolve().parents[1]
SUPABASE = DBT.parent / "supabase"
TEST_DB = "finflow_test"
DBT_ROLE = "finflow_dbt"


def local_url():
    raw = environ.get("TEST_DATABASE_URL")
    if not raw:
        sys.exit("TEST_DATABASE_URL is not set")
    url = urlsplit(raw)
    query = parse_qs(url.query)
    # libpq lets ?host= / ?hostaddr= override the hostname, so refuse them.
    if "host" in query or "hostaddr" in query or url.hostname not in ("localhost", "127.0.0.1"):
        sys.exit(f"TEST_DATABASE_URL must point at a local throwaway Postgres, got host {url.hostname}")
    return raw, url


def main(extra):
    raw, url = local_url()
    admin = psycopg2.connect(raw)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(f"drop database if exists {TEST_DB} with (force)")
        # Roles are cluster-wide: migration 0003 creates it again.
        cur.execute("drop role if exists finflow_readonly")
        cur.execute(f"create database {TEST_DB}")
    admin.close()

    files = sorted((SUPABASE / "migrations").glob("*.sql"))
    files += [SUPABASE / "seed.personal.example.sql", DBT / "fixtures" / "synthetic.sql"]
    files += [Path(f).resolve() for f in extra]
    db = psycopg2.connect(raw, dbname=TEST_DB)
    db.autocommit = True
    with db.cursor() as cur:
        for f in files:
            try:
                cur.execute(f.read_text())
            except psycopg2.Error as err:
                sys.exit(f"{f.name} failed: {err}")
        # dbt runs as the role migration 0013 gives it, never as the
        # loader's superuser, so a build that needs more privilege fails.
        cur.execute(f"alter role {DBT_ROLE} with password '{DBT_ROLE}'")
    db.close()

    exports = {
        "FINFLOW_DBT_HOST": url.hostname,
        "FINFLOW_DBT_PORT": str(url.port or 5432),
        "FINFLOW_DBT_USER": DBT_ROLE,
        "FINFLOW_DBT_PASSWORD": DBT_ROLE,
        "FINFLOW_DBT_DBNAME": TEST_DB,
    }
    for key, value in exports.items():
        print(f"export {key}={shlex.quote(value)}")


if __name__ == "__main__":
    main(sys.argv[1:])
