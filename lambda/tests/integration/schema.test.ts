import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeHelpers, resetData, sql, withClient } from "./db-helpers.js";

afterAll(closeHelpers);
beforeEach(resetData);

async function errorCode(text: string): Promise<string | undefined> {
  try {
    await sql(text);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

const SELF = "(select id from funding_sources where name = 'self')";
const SALARY = "(select id from income_sources where name = 'Salary')";

describe("migrations", () => {
  it("leave ingestions unique per update and event", async () => {
    const rows = await sql<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'ingestions'::regclass and contype = 'u'`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "ingestions_telegram_update_id_event_index_key",
    ]);
  });

  it("store money as numeric(12,2)", async () => {
    const rows = await sql(
      `select table_name::text, numeric_precision::int, numeric_scale::int
       from information_schema.columns
       where table_schema = 'public' and column_name = 'amount'
       order by table_name`,
    );
    expect(rows).toEqual([
      { table_name: "transaction_items", numeric_precision: 12, numeric_scale: 2 },
      { table_name: "transactions", numeric_precision: 12, numeric_scale: 2 },
    ]);
  });

  it("accept several events for one update", async () => {
    await sql(
      `insert into ingestions (source, telegram_update_id, event_index, raw_payload)
       values ('text', 4, 0, '{}'), ('text', 4, 1, '{}')`,
    );
    const [{ n }] = await sql<{ n: number }>(
      "select count(*)::int n from ingestions where telegram_update_id = 4",
    );
    expect(n).toBe(2);
  });
});

describe("constraints", () => {
  it.each([
    [
      "income without a source",
      `insert into transactions (occurred_on, type, amount, description)
       values ('2026-10-20', 'income', 10, 'x')`,
      "23514",
    ],
    [
      "a transfer without an account",
      `insert into transactions (occurred_on, type, amount, description)
       values ('2026-10-20', 'transfer', 10, 'x')`,
      "23514",
    ],
    [
      "an expense without a funder",
      `insert into transactions (occurred_on, type, amount, description)
       values ('2026-10-20', 'expense', 10, 'x')`,
      "23514",
    ],
    [
      "income with a funder",
      `insert into transactions (occurred_on, type, amount, description, income_source_id, funding_source_id)
       values ('2026-10-20', 'income', 10, 'x', ${SALARY}, ${SELF})`,
      "23514",
    ],
    [
      "a zero amount",
      `insert into transactions (occurred_on, type, amount, description, funding_source_id)
       values ('2026-10-20', 'expense', 0, 'x', ${SELF})`,
      "23514",
    ],
    [
      "a negative event index",
      `insert into ingestions (source, telegram_update_id, event_index, raw_payload)
       values ('text', 1, -1, '{}')`,
      "23514",
    ],
    [
      "an unknown ingestion status",
      `insert into ingestions (source, telegram_update_id, raw_payload, status)
       values ('text', 2, '{}', 'bogus')`,
      "23514",
    ],
    [
      "two rows for the same update and event",
      `insert into ingestions (source, telegram_update_id, raw_payload)
       values ('text', 3, '{}'), ('text', 3, '{}')`,
      "23505",
    ],
  ])("reject %s", async (_name, text, code) => {
    expect(await errorCode(text)).toBe(code);
  });
});

describe("finflow_readonly", () => {
  it("can read every table but write none", async () => {
    await withClient(async (client) => {
      await client.query("SET ROLE finflow_readonly");
      await expect(
        client.query("select count(*) from transactions"),
      ).resolves.toBeDefined();
      await expect(
        client.query("insert into tags (name) values ('x')"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
