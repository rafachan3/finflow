export const TEST_DB = "finflow_test";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Server-level URL; the suite drops and recreates TEST_DB on it. */
export function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is not set");
  const host = new URL(raw).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `TEST_DATABASE_URL must point at a local throwaway Postgres, got host ${host}`,
    );
  }
  return raw;
}

export function testDbUrl(): string {
  const url = new URL(adminUrl());
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}
