import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Extraction } from "../src/extraction.js";

const query = vi.fn();

vi.mock("../src/config.js", () => ({
  getConfig: vi.fn(async () => ({ databaseUrl: "postgres://x" })),
}));
vi.mock("pg", () => ({
  Pool: vi.fn(function () {
    return {
      query,
      connect: async () => ({ query, release: () => {} }),
    };
  }),
}));

const {
  confirmIngestion,
  insertPendingIngestions,
  setIngestionAwaitingDate,
  setIngestionAwaitingEdit,
} = await import("../src/db.js");

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

    await expect(confirmIngestion("ing")).resolves.toMatchObject({ status: "confirmed" });

    expect(insertParams()).toContain("decluttering before the move");
  });

  it("writes null notes for rows extracted before notes existed", async () => {
    routeQueries(income);

    await confirmIngestion("ing");

    expect(insertParams().at(-1)).toBeNull();
  });
});

describe("insertPendingIngestions", () => {
  const row = (eventIndex: number) => ({
    id: `00000000-0000-0000-0000-00000000000${eventIndex}`,
    source: "text" as const,
    mediaPath: null,
    telegramUpdateId: 77,
    eventIndex,
    rawPayload: { update_id: 77 },
    extraction: income,
  });

  it("inserts every row with its event_index inside one transaction", async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) =>
      String(sql).startsWith("INSERT INTO ingestions")
        ? { rowCount: 1, rows: [{ id: params?.[0] }] }
        : { rowCount: 0, rows: [] },
    );

    const result = await insertPendingIngestions([row(0), row(1)]);

    expect(result).toEqual([{ id: row(0).id }, { id: row(1).id }]);
    const sqls = query.mock.calls.map(([sql]) => String(sql).split(/\s/)[0]);
    expect(sqls).toEqual(["BEGIN", "SELECT", "SELECT", "INSERT", "INSERT", "COMMIT"]);
    expect(String(query.mock.calls[1][0])).toMatch(/pg_advisory_xact_lock/);
    expect(query.mock.calls[1][1]).toEqual([77]);
    expect(String(query.mock.calls[2][0])).toMatch(/FROM ingestions WHERE telegram_update_id/);
    expect(query.mock.calls[2][1]).toEqual([77]);
    const inserts = query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT"));
    expect(String(inserts[0][0])).toMatch(/event_index/);
    expect(inserts.map(([, params]) => (params as unknown[])[3])).toEqual([0, 1]);
  });

  it("rolls back and reports a duplicate when a retry hits the unique key", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith("INSERT")) {
        throw Object.assign(new Error("dup"), { code: "23505" });
      }
      return { rowCount: 0, rows: [] };
    });

    await expect(insertPendingIngestions([row(0), row(1)])).resolves.toBe("duplicate");
    const sqls = query.mock.calls.map(([sql]) => String(sql).split(/\s/)[0]);
    expect(sqls).toEqual(["BEGIN", "SELECT", "SELECT", "INSERT", "ROLLBACK"]);
  });

  it("returns duplicate without inserting when the update already has rows", async () => {
    query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM ingestions WHERE telegram_update_id")
        ? { rowCount: 1, rows: [{ "?column?": 1 }] }
        : { rowCount: 0, rows: [] },
    );

    await expect(insertPendingIngestions([row(0)])).resolves.toBe("duplicate");
    const sqls = query.mock.calls.map(([sql]) => String(sql).split(/\s/)[0]);
    expect(sqls).toEqual(["BEGIN", "SELECT", "SELECT", "ROLLBACK"]);
    expect(sqls).not.toContain("INSERT");
  });

  it("returns an empty list without a transaction for no rows", async () => {
    await expect(insertPendingIngestions([])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("setIngestionAwaiting*", () => {
  const id = "00000000-0000-0000-0000-000000000001";

  it.each([
    ["Date", setIngestionAwaitingDate],
    ["Edit", setIngestionAwaitingEdit],
  ])("%s returns busy and skips the UPDATE when another row is waiting", async (_n, fn) => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ "?column?": 1 }] });

    await expect(fn(id)).resolves.toBe("busy");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("id <> $1");
    expect(params).toEqual([id]);
    expect(String(sql)).not.toMatch(/UPDATE/);
  });

  it.each([
    ["Date", setIngestionAwaitingDate, "awaiting_date"],
    ["Edit", setIngestionAwaitingEdit, "awaiting_edit"],
  ])("%s returns started when nothing else waits and the UPDATE hits a row", async (_n, fn, status) => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(fn(id)).resolves.toBe("started");

    expect(query.mock.calls[1][1]).toEqual([id, status]);
  });

  it.each([
    ["Date", setIngestionAwaitingDate],
    ["Edit", setIngestionAwaitingEdit],
  ])("%s returns already_handled when the UPDATE hits no row", async (_n, fn) => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(fn(id)).resolves.toBe("already_handled");
  });
});
