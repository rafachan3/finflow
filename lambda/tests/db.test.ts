import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extraction } from "../src/extraction.js";

const query = vi.fn();

vi.mock("../src/config.js", () => ({
  getConfig: vi.fn(async () => ({ databaseUrl: "postgres://x" })),
}));
vi.mock("pg", () => ({
  Pool: vi.fn(() => ({
    connect: async () => ({ query, release: () => {} }),
  })),
}));

const { confirmIngestion } = await import("../src/db.js");

const income: Extraction = {
  type: "income",
  amount: "20.00",
  currency: "CAD",
  date: "2026-10-12",
  description: "sold a lamp",
  merchant: null,
  venue: null,
  tags: [],
  funded_by: null,
  is_recurring: false,
  income_source: "Salary",
  to_account: null,
  items: [],
  confidence: 0.9,
};

function routeQueries(extraction: Extraction) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM ingestions WHERE id")) {
      return { rowCount: 1, rows: [{ id: "ing", status: "pending", extraction }] };
    }
    if (sql.includes("FROM income_sources ORDER BY")) {
      return { rowCount: 1, rows: [{ name: "Salary" }] };
    }
    if (sql.includes("FROM income_sources WHERE")) {
      return { rowCount: 1, rows: [{ id: 1 }] };
    }
    if (sql.includes("INSERT INTO transactions")) {
      return { rowCount: 1, rows: [{ id: "tx" }] };
    }
    return { rowCount: 0, rows: [] };
  });
}

function insertParams(): unknown[] {
  const call = query.mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO transactions"),
  );
  if (!call) throw new Error("no transactions insert");
  expect(String(call[0])).toMatch(/notes/);
  return call[1] as unknown[];
}

beforeEach(() => {
  query.mockReset();
});

describe("confirmIngestion", () => {
  it("writes the note to transactions.notes", async () => {
    routeQueries({ ...income, notes: "decluttering before the move" });

    await expect(confirmIngestion("ing")).resolves.toBe("confirmed");

    expect(insertParams()).toContain("decluttering before the move");
  });

  it("writes null notes for rows extracted before notes existed", async () => {
    routeQueries(income);

    await confirmIngestion("ing");

    expect(insertParams().at(-1)).toBeNull();
  });
});
