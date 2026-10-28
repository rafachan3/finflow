import { afterEach, describe, expect, it } from "vitest";
import { adminUrl, testDbUrl } from "./integration/env.js";

const saved = process.env.TEST_DATABASE_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = saved;
});

describe("test database guard", () => {
  it("refuses a database that is not on this machine", () => {
    process.env.TEST_DATABASE_URL =
      "postgres://postgres.ref:pw@aws-0-ca-central-1.pooler.supabase.com:5432/postgres";
    expect(() => adminUrl()).toThrow(/local throwaway Postgres/);
  });

  it("refuses to run without TEST_DATABASE_URL", () => {
    delete process.env.TEST_DATABASE_URL;
    expect(() => adminUrl()).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it("points tests at the finflow_test database on the same server", () => {
    process.env.TEST_DATABASE_URL =
      "postgres://postgres:postgres@localhost:54329/postgres";
    expect(testDbUrl()).toBe(
      "postgres://postgres:postgres@localhost:54329/finflow_test",
    );
  });
});
