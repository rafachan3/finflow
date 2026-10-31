import { readFileSync } from "node:fs";
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
const SAVINGS = "(select id from accounts where name = 'Emergency fund')";
const INVESTMENT = "(select id from accounts where name = 'Retirement account')";

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

  it("accept a deposit, a withdrawal and a move between two accounts as transfers", async () => {
    await sql(
      `insert into transactions (occurred_on, type, amount, description, from_account_id, to_account_id)
       values ('2026-10-20', 'transfer', 10, 'deposit', null, ${SAVINGS}),
              ('2026-10-20', 'transfer', 10, 'withdrawal', ${SAVINGS}, null),
              ('2026-10-20', 'transfer', 10, 'move', ${SAVINGS}, ${INVESTMENT})`,
    );
    const [{ n }] = await sql<{ n: number }>("select count(*)::int n from transactions");
    expect(n).toBe(3);
  });

  it("let an income source name the account its income lands in", async () => {
    await withClient(async (client) => {
      await client.query("begin");
      await client.query(
        `update income_sources set deposit_account_id = ${SAVINGS} where name = 'Salary'`,
      );
      const { rows } = await client.query(
        `select a.name as account from income_sources s
         join accounts a on a.id = s.deposit_account_id where s.name = 'Salary'`,
      );
      await client.query("rollback");
      expect(rows).toEqual([{ account: "Emergency fund" }]);
    });
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
      "a transfer from and to the same account",
      `insert into transactions (occurred_on, type, amount, description, from_account_id, to_account_id)
       values ('2026-10-20', 'transfer', 10, 'x', ${SAVINGS}, ${SAVINGS})`,
      "23514",
    ],
    [
      "an expense with a from account",
      `insert into transactions (occurred_on, type, amount, description, funding_source_id, from_account_id)
       values ('2026-10-20', 'expense', 10, 'x', ${SELF}, ${SAVINGS})`,
      "23514",
    ],
    [
      "income with a from account",
      `insert into transactions (occurred_on, type, amount, description, income_source_id, from_account_id)
       values ('2026-10-20', 'income', 10, 'x', ${SALARY}, ${SAVINGS})`,
      "23514",
    ],
    [
      "an income source landing in an account that does not exist",
      `update income_sources set deposit_account_id = 32000 where name = 'Salary'`,
      "23503",
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

describe("recurring series", () => {
  async function series(name: string, kind = "expense"): Promise<number> {
    const source = kind === "income" ? SALARY : "null";
    const [{ id }] = await sql<{ id: number }>(
      `insert into recurring_series (name, kind, cadence, income_source_id)
       values ('${name}', '${kind}', 'monthly', ${source}) returning id`,
    );
    return id;
  }

  async function expense(seriesId: number | null = null, isRecurring = false): Promise<string> {
    const [{ id }] = await sql<{ id: string }>(
      `insert into transactions (occurred_on, type, amount, description, funding_source_id, is_recurring, recurring_series_id)
       values ('2026-10-15', 'expense', 64.99, 'Internet bill', ${SELF}, $1, $2) returning id::text`,
      [isRecurring, seriesId],
    );
    return id;
  }

  async function flag(id: string): Promise<{ is_recurring: boolean; recurring_series_id: number | null }> {
    const [row] = await sql<{ is_recurring: boolean; recurring_series_id: number | null }>(
      "select is_recurring, recurring_series_id from transactions where id = $1",
      [id],
    );
    return row;
  }

  it("links a transaction to a series of its own kind and refuses another kind", async () => {
    const internet = await series("Internet bill");
    const salary = await series("Salary", "income");
    const tx = await expense(internet);
    expect(await flag(tx)).toEqual({ is_recurring: true, recurring_series_id: internet });

    // The composite FK (recurring_series_id, type) → (id, kind) refuses an
    // expense in an income series, on update as on insert.
    expect(await errorCode(`update transactions set recurring_series_id = ${salary} where id = '${tx}'`)).toBe("23503");
    expect(
      await errorCode(
        `insert into transactions (occurred_on, type, amount, description, funding_source_id, recurring_series_id)
         values ('2026-10-15', 'expense', 10, 'x', ${SELF}, ${salary})`,
      ),
    ).toBe("23503");
    // A linked row cannot change type away from its series' kind, nor the series its kind.
    expect(
      await errorCode(`update transactions set type = 'income', funding_source_id = null,
                         income_source_id = ${SALARY} where id = '${tx}'`),
    ).toBe("23503");
    expect(await errorCode(`update recurring_series set kind = 'income', income_source_id = ${SALARY} where id = ${internet}`)).toBe("23503");
  });

  it("linking sets is_recurring and unlinking clears it", async () => {
    const internet = await series("Internet bill");
    const tx = await expense();
    expect((await flag(tx)).is_recurring).toBe(false);

    await sql(`update transactions set recurring_series_id = ${internet} where id = '${tx}'`);
    expect(await flag(tx)).toEqual({ is_recurring: true, recurring_series_id: internet });

    // Writing the flag alone cannot make a linked row non-recurring.
    await sql(`update transactions set is_recurring = false where id = '${tx}'`);
    expect((await flag(tx)).is_recurring).toBe(true);

    await sql(`update transactions set recurring_series_id = null where id = '${tx}'`);
    expect(await flag(tx)).toEqual({ is_recurring: false, recurring_series_id: null });
  });

  it("keeps a legacy flag on an unlinked insert and through merchant linking, and lets it be cleared", async () => {
    // Transitional (migration 0016): Confirm still writes Gemini's guess until
    // the card links series; 0017 closes the guarantee after the backfill.
    const tx = await expense(null, true);
    expect(await flag(tx)).toEqual({ is_recurring: true, recurring_series_id: null });
    await sql(`update transactions set merchant_id = (select id from merchants where name = 'Acme Mart') where id = '${tx}'`);
    expect((await flag(tx)).is_recurring).toBe(true);
    await sql(`update transactions set is_recurring = false where id = '${tx}'`);
    expect((await flag(tx)).is_recurring).toBe(false);
  });

  it("deleting a series unlinks its transactions and clears their flag", async () => {
    const internet = await series("Internet bill");
    const tx = await expense(internet);
    await sql(`insert into recurring_pauses (series_id, paused_from) values (${internet}, '2026-11-01')`);
    await sql(`insert into recurring_skips (series_id, due_on) values (${internet}, '2026-11-15')`);
    const other = await expense();
    await sql(`insert into recurring_exclusions (series_id, transaction_id) values (${internet}, '${other}')`);

    await sql(`delete from recurring_series where id = ${internet}`);
    expect(await flag(tx)).toEqual({ is_recurring: false, recurring_series_id: null });
    const [{ n }] = await sql<{ n: number }>(
      `select (select count(*) from recurring_pauses) + (select count(*) from recurring_skips)
            + (select count(*) from recurring_exclusions) as n`,
    );
    expect(Number(n)).toBe(0);
    expect(await sql("select 1 from transactions where id = $1", [other])).toHaveLength(1);
  });

  it("refuses a pause that overlaps another pause of the series", async () => {
    const phone = await series("Phone bill");
    const gym = await series("Gym");
    const pause = (id: number, from: string, until: string | null) =>
      `insert into recurring_pauses (series_id, paused_from, resumed_on)
       values (${id}, '${from}', ${until === null ? "null" : `'${until}'`})`;
    await sql(pause(phone, "2026-07-01", "2026-09-01"));
    expect(await errorCode(pause(phone, "2026-08-15", null))).toBe("23P01");
    // [from, resumed_on) is half-open: a pause starting the day the last one
    // ended does not overlap, and another series' pauses are independent.
    await sql(pause(phone, "2026-09-01", null));
    await sql(pause(gym, "2026-08-15", null));
    expect(await errorCode(pause(gym, "2026-10-01", "2026-10-01"))).toBe("23514");
  });

  it("drops an exclusion with its transaction, and remembers a dismissed proposal once", async () => {
    const internet = await series("Internet bill");
    const tx = await expense();
    const exclude = `insert into recurring_exclusions (series_id, transaction_id) values (${internet}, '${tx}')`;
    await sql(exclude);
    expect(await errorCode(exclude)).toBe("23505");
    await sql("delete from transactions where id = $1", [tx]);
    expect(await sql("select 1 from recurring_exclusions")).toEqual([]);

    const dismiss = "insert into recurring_dismissed (group_key) values ('desc:internet')";
    await sql(dismiss);
    expect(await errorCode(dismiss)).toBe("23505");
  });

  it.each([
    ["a blank name", `insert into recurring_series (name, kind, cadence) values ('  ', 'expense', 'monthly')`, "23514"],
    ["an unknown cadence", `insert into recurring_series (name, kind, cadence) values ('Gym', 'expense', 'daily')`, "22P02"],
    ["income without a source", `insert into recurring_series (name, kind, cadence) values ('Salary', 'income', 'biweekly')`, "23514"],
    ["an expense with a source", `insert into recurring_series (name, kind, cadence, income_source_id) values ('Gym', 'expense', 'monthly', ${SALARY})`, "23514"],
    ["a transfer without an account", `insert into recurring_series (name, kind, cadence) values ('Savings', 'transfer', 'monthly')`, "23514"],
    ["a transfer from and to the same account", `insert into recurring_series (name, kind, cadence, from_account_id, to_account_id) values ('Savings', 'transfer', 'monthly', ${SAVINGS}, ${SAVINGS})`, "23514"],
    ["an expense with an account", `insert into recurring_series (name, kind, cadence, to_account_id) values ('Gym', 'expense', 'monthly', ${INVESTMENT})`, "23514"],
    ["income with a merchant", `insert into recurring_series (name, kind, cadence, income_source_id, merchant_id) values ('Salary', 'income', 'monthly', ${SALARY}, (select min(id) from merchants))`, "23514"],
    ["two series whose names differ only by case and spaces", `insert into recurring_series (name, kind, cadence) values ('Gym', 'expense', 'monthly'), (' gym ', 'expense', 'weekly')`, "23505"],
    ["the same skip twice", `with s as (insert into recurring_series (name, kind, cadence) values ('Gym', 'expense', 'monthly') returning id)
       insert into recurring_skips (series_id, due_on) select id, '2026-08-03'::date from s cross join generate_series(1, 2)`, "23505"],
  ])("refuse a recurring series with %s", async (_name, text, code) => {
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

describe("the Data API roles", () => {
  // Supabase's anon and authenticated do not exist on the throwaway Postgres,
  // so this creates them with the grants Supabase gives them (DECISIONS
  // 2026-10-30), runs migration 0015 again, and checks with the dbt guard the
  // nightly runs on production.
  const migration = readFileSync(
    new URL("../../../supabase/migrations/20261030000015_revoke_data_api_grants.sql", import.meta.url),
    "utf8",
  );
  const guard = readFileSync(
    new URL("../../../dbt/tests/data_api_roles_reach_nothing.sql", import.meta.url),
    "utf8",
  );
  const API = "anon, authenticated";

  async function supabaseGrants(): Promise<void> {
    await sql(`create function public.data_api_probe() returns int language sql as 'select 1'`);
    for (const role of ["anon", "authenticated", "supabase_admin"]) {
      await sql(`do $$ begin
        if not exists (select from pg_roles where rolname = '${role}') then
          create role ${role} nologin noinherit;
        end if; end $$`);
    }
    await sql(`grant usage on schema public, staging, marts to ${API}`);
    await sql(`grant all on all tables in schema public to ${API}`);
    await sql(`grant all on all sequences in schema public to ${API}`);
    await sql(`grant all on all routines in schema public to ${API}`);
    for (const owner of ["postgres", "supabase_admin"]) {
      for (const kind of ["tables", "sequences", "functions"]) {
        await sql(`alter default privileges for role ${owner} in schema public grant all on ${kind} to ${API}`);
      }
    }
    await sql(`alter default privileges grant all on tables to ${API}`);
  }

  async function dropApiRoles(): Promise<void> {
    await sql("drop table if exists public.data_api_later");
    await sql("drop function if exists public.data_api_probe()");
    for (const role of ["anon", "authenticated", "supabase_admin"]) {
      await sql(`do $$ begin
        if exists (select from pg_roles where rolname = '${role}') then
          drop owned by ${role}; drop role ${role};
        end if; end $$`);
    }
  }

  it("lose every grant Supabase gives them, and later tables are not granted to them", async () => {
    await dropApiRoles();
    await supabaseGrants();
    try {
      // The setup bites: before the revoke, anon reads the ledger and the guard sees it.
      await asRole("anon", async (q) => {
        await expect(q("select count(*) from transactions")).resolves.toBeDefined();
      });
      expect((await sql(guard)).length).toBeGreaterThan(0);

      await sql(migration);
      await sql(migration); // a rerun is a no-op

      expect(await sql(guard)).toEqual([]);
      for (const role of ["anon", "authenticated"]) {
        await asRole(role, async (q) => {
          await denied(q, "select count(*) from transactions");
          await denied(q, "select raw_payload from ingestions");
          await denied(q, "insert into tags (name) values ('x')");
          await denied(q, "select nextval('tags_id_seq')");
        });
      }
      const defaults = await sql(
        `select 1 from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
         where a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated'))`,
      );
      expect(defaults).toEqual([]);

      // A table a later migration adds: still nothing for anon, still read by
      // finflow_readonly and finflow_dbt through their own default privileges.
      await sql("create table public.data_api_later (x int)");
      expect(await sql(guard)).toEqual([]);
      await asRole("anon", (q) => denied(q, "select x from data_api_later"));
      for (const role of ["finflow_readonly", "finflow_dbt"]) {
        await asRole(role, async (q) => {
          await expect(q("select x from data_api_later")).resolves.toBeDefined();
          await expect(q("select count(*) from transactions")).resolves.toBeDefined();
        });
      }
    } finally {
      await dropApiRoles();
    }
  });

  it("migration 0015 is a no-op where the roles do not exist", async () => {
    await dropApiRoles();
    await expect(sql(migration)).resolves.toBeDefined();
    expect(await sql(guard)).toEqual([]);
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
