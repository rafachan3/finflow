#!/usr/bin/env bash
# Run a command with TEST_DATABASE_URL pointing at a throwaway local Postgres.
#
#   scripts/with-test-db.sh <command> [args...]
#
# If TEST_DATABASE_URL is already set (CI's service container), the command
# runs against it unchanged. Otherwise this starts a postgres:17 container
# with a name unique to this run, on a free 127.0.0.1 port, and removes it
# when the command exits, whether it passed, failed or was interrupted.
# The test harness itself still refuses any host but this machine.
set -euo pipefail

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  exec "$@"
fi

if ! docker info >/dev/null 2>&1; then
  echo "with-test-db: Docker is not running. Start Docker, or set TEST_DATABASE_URL to a local Postgres." >&2
  exit 1
fi

name="finflow-test-db-run-$$-$RANDOM"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1::5432 postgres:17 >/dev/null
port=$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')

# Over TCP, so the image's init-time server (socket only) does not count as ready.
for _ in $(seq 60); do
  if docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 0.5
done
docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres || {
  echo "with-test-db: $name did not accept connections within 30s" >&2
  exit 1
}

echo "with-test-db: $name on port $port (removed on exit)" >&2
export TEST_DATABASE_URL="postgres://postgres:postgres@localhost:$port/postgres"
"$@"
