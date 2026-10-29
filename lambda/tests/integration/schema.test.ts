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

  it("keep a line's own tags once each, and drop them with the line", async () => {
    const [{ id: tx }] = await sql<{ id: string }>(
      `insert into transactions (occurred_on, type, amount, description, funding_source_id)
       values ('2026-10-20', 'expense', 10, 'x', ${SELF}) returning id::text`,
    );
    const [{ id: line }] = await sql<{ id: string }>(
      `insert into transaction_items (transaction_id, description, amount, subcategory_id, bucket)
       values ($1, 'Bananas', 10, (select min(id) from subcategories), 'wants') returning id::text`,
      [tx],
    );
    const tag = `insert into transaction_item_tags (transaction_item_id, tag_id)
                 values ('${line}', (select id from tags where name = 'Travel'))`;
    await sql(tag);
    expect(await errorCode(tag)).toBe("23505");

    await sql("delete from transactions where id = $1", [tx]);
    const [{ n }] = await sql<{ n: number }>("select count(*)::int n from transaction_item_tags");
    expect(n).toBe(0);
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

/** Runs fn as `role` on one connection; withClient resets the role after. */
async function asRole(
  role: string,
  fn: (q: (text: string) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SET ROLE ${role}`);
    await fn((text) => client.query(text));
  });
}

async function denied(q: (text: string) => Promise<unknown>, text: string): Promise<void> {
  await expect(q(text)).rejects.toMatchObject({ code: "42501" });
}

describe("finflow_dbt", () => {
  it("holds SELECT on every public table and no write privilege on any", async () => {
    const tables = await sql<{ name: string; can_read: boolean; can_write: boolean }>(
      `select c.relname::text as name,
              has_table_privilege('finflow_dbt', c.oid, 'select') as can_read,
              has_table_privilege('finflow_dbt', c.oid, 'insert, update, delete, truncate, references, trigger') as can_write
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by c.relname`,
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((t) => !t.can_read).map((t) => t.name)).toEqual([]);
    expect(tables.filter((t) => t.can_write).map((t) => t.name)).toEqual([]);
  });

  it("selects from the ledger but is refused every write and any CREATE in public", async () => {
    await asRole("finflow_dbt", async (q) => {
      await expect(q("select count(*) from transactions")).resolves.toBeDefined();
      await expect(q("select count(*) from ingestions")).resolves.toBeDefined();
      await denied(q, "insert into tags (name) values ('x')");
      await denied(q, "update merchants set name = name");
      await denied(q, "delete from tags");
      await denied(q, "truncate transactions cascade");
      await denied(q, "create table public.dbt_scratch (x int)");
      await denied(q, "create view public.dbt_scratch as select 1 as x");
    });
  });

  it.each(["staging", "marts"])("creates, replaces and drops tables and views in %s", async (schema) => {
    await asRole("finflow_dbt", async (q) => {
      await q(`create table ${schema}.t as select count(*) as n from transactions`);
      await q(`create view ${schema}.v as select * from ${schema}.t`);
      await q(`drop view ${schema}.v`);
      await q(`drop table ${schema}.t`);
      await q(`create table ${schema}.t as select 1 as n`);
      await q(`alter table ${schema}.t rename to t_old`);
      await q(`create table ${schema}.t as select 2 as n`);
      await q(`drop table ${schema}.t, ${schema}.t_old`);
    });
  });

  it("cannot drop or take over its schemas, or create a schema", async () => {
    await asRole("finflow_dbt", async (q) => {
      await denied(q, "drop schema marts cascade");
      await denied(q, "drop schema staging cascade");
      await denied(q, "create schema dbt_scratch");
    });
  });
});

describe("finflow_analyst", () => {
  async function dbtBuildsMart(): Promise<void> {
    await asRole("finflow_dbt", async (q) => {
      await q("create table marts.analyst_probe as select 42 as answer");
    });
  }
  async function dropMart(): Promise<void> {
    await sql("drop table if exists marts.analyst_probe");
  }

  it("reads a mart table dbt builds, including after dbt drops and rebuilds it", async () => {
    await dropMart();
    await dbtBuildsMart();
    try {
      await asRole("finflow_analyst", async (q) => {
        await expect(q("select answer from marts.analyst_probe")).resolves.toMatchObject({
          rows: [{ answer: 42 }],
        });
      });
      await asRole("finflow_dbt", async (q) => {
        await q("drop table marts.analyst_probe");
      });
      await dbtBuildsMart();
      await asRole("finflow_analyst", async (q) => {
        await expect(q("select answer from marts.analyst_probe")).resolves.toBeDefined();
      });
    } finally {
      await dropMart();
    }
  });

  it("reads no ledger table: not transactions, not the raw Telegram payloads", async () => {
    await asRole("finflow_analyst", async (q) => {
      await denied(q, "select count(*) from transactions");
      await denied(q, "select raw_payload from ingestions");
      await denied(q, "select count(*) from transaction_items");
    });
    const tables = await sql<{ name: string }>(
      `select c.relname::text as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and has_table_privilege('finflow_analyst', c.oid, 'select, insert, update, delete')`,
    );
    expect(tables).toEqual([]);
  });

  it("cannot read staging, write a mart, or create anything", async () => {
    await dropMart();
    await dbtBuildsMart();
    try {
      await asRole("finflow_analyst", async (q) => {
        await denied(q, "create table staging.t as select 1 as n");
        await denied(q, "select 1 from staging.t");
        await denied(q, "insert into marts.analyst_probe values (1)");
        await denied(q, "update marts.analyst_probe set answer = 0");
        await denied(q, "delete from marts.analyst_probe");
        await denied(q, "drop table marts.analyst_probe");
        await denied(q, "create table marts.t as select 1 as n");
        await denied(q, "create table public.t as select 1 as n");
        await denied(q, "create schema analyst_scratch");
      });
    } finally {
      await dropMart();
    }
  });
});
