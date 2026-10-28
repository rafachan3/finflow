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
    const rows = await sql<{ columns: string[] }>(
      `select array_agg(a.attname::text order by k.ord) as columns
       from pg_constraint c
       cross join unnest(c.conkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.conrelid = 'ingestions'::regclass and c.contype = 'u'
       group by c.oid`,
    );
    expect(rows).toContainEqual({ columns: ["telegram_update_id", "event_index"] });
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
  it("can read every public table and write none of them", async () => {
    const tables = await sql<{ name: string; can_read: boolean; can_write: boolean }>(
      `select c.relname::text as name,
              has_table_privilege('finflow_readonly', c.oid, 'select') as can_read,
              has_table_privilege('finflow_readonly', c.oid, 'insert, update, delete, truncate') as can_write
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`,
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((t) => !t.can_read).map((t) => t.name)).toEqual([]);
    expect(tables.filter((t) => t.can_write).map((t) => t.name)).toEqual([]);
  });

  it("is refused a write when it tries one", async () => {
    await withClient(async (client) => {
      await client.query("SET ROLE finflow_readonly");
      await expect(client.query("select count(*) from transactions")).resolves.toBeDefined();
      await expect(
        client.query("insert into tags (name) values ('x')"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
