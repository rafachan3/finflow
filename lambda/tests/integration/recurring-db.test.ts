import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeHelpers, insertTransaction, resetData, sql, withClient } from "./db-helpers.js";

vi.mock("../../src/config.js", async () => {
  const { testDbUrl } = await import("./env.js");
  return { getConfig: async () => ({ databaseUrl: testDbUrl() }) };
});

const db = await import("../../src/db.js");
const rdb = await import("../../src/recurring-db.js");

afterAll(async () => {
  await db.closePool();
  await closeHelpers();
});
beforeEach(resetData);

const internet = (date: string, over: Record<string, unknown> = {}) =>
  insertTransaction({ date, amount: "64.99", description: "Internet bill", subcategory: "Internet and phone", ...over });

async function created(transactionId: string, name = "Internet bill"): Promise<number> {
  const result = await rdb.createSeries({ transactionId, name, cadence: "monthly", amountVaries: false });
  if (!("created" in result)) throw new Error(`not created: ${JSON.stringify(result)}`);
  return result.created;
}

async function links(): Promise<Record<string, { series: number | null; flagged: boolean }>> {
  const rows = await sql<{ id: string; series: number | null; flagged: boolean }>(
    "select id::text, recurring_series_id as series, is_recurring as flagged from transactions",
  );
  return Object.fromEntries(rows.map((r) => [r.id, { series: r.series, flagged: r.flagged }]));
}

async function exclusions(): Promise<string[]> {
  const rows = await sql<{ e: string }>(
    "select series_id || ':' || transaction_id as e from recurring_exclusions order by 1",
  );
  return rows.map((r) => r.e);
}

describe("loadBook", () => {
  it("reads series with their keys, every transaction with its largest line's subcategory, and pauses, skips, exclusions and dismissals", async () => {
    const tx = await internet("2026-10-15", { merchant: "Acme Mart" });
    const pay = await insertTransaction({ date: "2026-10-16", type: "income", amount: "2000.00", description: "Pay", source: "Salary" });
    const sid = await created(tx);
    await sql("insert into recurring_pauses (series_id, paused_from, resumed_on) values ($1, '2026-09-01', null)", [sid]);
    await sql("insert into recurring_skips (series_id, due_on) values ($1, '2026-08-15')", [sid]);
    await sql("insert into recurring_exclusions (series_id, transaction_id) values ($1, $2)", [sid, pay]);
    await rdb.dismissGroup("merchant:9");

    const book = await rdb.loadBook();
    const [sub] = await sql<{ id: number }>("select id from subcategories where name = 'Internet and phone'");
    const [acme] = await sql<{ id: number }>("select id from merchants where name = 'Acme Mart'");
    expect(book.series).toEqual([
      {
        id: sid, name: "Internet bill", kind: "expense", cadence: "monthly", amountVaries: false,
        merchantId: acme.id, subcategoryId: sub.id, incomeSourceId: null, fromAccountId: null, toAccountId: null,
        keywords: [], subcategory: "Bills › Internet and phone", source: null, fromAccount: null, toAccount: null,
      },
    ]);
    expect(book.rows.map((r) => [r.id, r.date, r.type, r.amount, r.seriesId, r.flagged, r.merchant, r.source, r.subcategoryId])).toEqual([
      [tx, "2026-10-15", "expense", "64.99", sid, true, "Acme Mart", null, sub.id],
      [pay, "2026-10-16", "income", "2000.00", null, false, null, "Salary", null],
    ]);
    expect(book.pauses.get(sid)).toEqual([{ from: "2026-09-01", until: null }]);
    expect(book.skips.get(sid)).toEqual(["2026-08-15"]);
    expect(book.excluded.get(sid)).toEqual([pay]);
    expect(book.dismissed).toEqual(["merchant:9"]);
  });
});

describe("createSeries", () => {
  it("makes a series from a saved transaction with its keys and links that transaction", async () => {
    const tx = await internet("2026-10-15");
    const sid = await created(tx);
    expect((await links())[tx]).toEqual({ series: sid, flagged: true });

    const pay = await insertTransaction({ date: "2026-10-16", type: "income", amount: "2000.00", description: "Pay", source: "Salary" });
    const move = await insertTransaction({ date: "2026-10-17", type: "transfer", amount: "100.00", description: "Save", to: "Emergency fund" });
    const salary = await created(pay, "Salary");
    const saving = await created(move, "Savings");
    const keys = await sql(
      `select name, kind::text, merchant_id, subcategory_id is not null as sub, income_source_id is not null as src,
              from_account_id, to_account_id is not null as to_acct
       from recurring_series where id = any($1) order by id`,
      [[salary, saving]],
    );
    expect(keys).toEqual([
      { name: "Salary", kind: "income", merchant_id: null, sub: false, src: true, from_account_id: null, to_acct: false },
      { name: "Savings", kind: "transfer", merchant_id: null, sub: false, src: false, from_account_id: null, to_acct: true },
    ]);
  });

  it("a second tap on the same transaction creates nothing and names its series", async () => {
    const tx = await internet("2026-10-15");
    const sid = await created(tx);
    expect(await rdb.createSeries({ transactionId: tx, name: "Internet bill", cadence: "monthly", amountVaries: false })).toEqual({
      already: sid,
      name: "Internet bill",
    });
    expect(await sql("select count(*)::int as n from recurring_series")).toEqual([{ n: 1 }]);
  });

  it("refuses a name another series has, in any case, and writes nothing", async () => {
    await created(await internet("2026-09-15"));
    const other = await internet("2026-10-15");
    expect(await rdb.createSeries({ transactionId: other, name: " internet BILL", cadence: "monthly", amountVaries: false })).toEqual({ taken: true });
    expect((await links())[other]).toEqual({ series: null, flagged: false });
  });

  it("reports a transaction that is gone", async () => {
    expect(
      await rdb.createSeries({ transactionId: "00000000-0000-4000-8000-000000000000", name: "X", cadence: "monthly", amountVaries: true }),
    ).toEqual({ missing: true });
  });
});

/** Waits until some backend is blocked on a lock: the statement under test is queued behind the helper's transaction. */
async function blockedOnLock(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [row] = await sql<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()",
    );
    if (row.n > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the statement never waited on the lock");
}

describe("concurrent double taps", () => {
  it("a create that waits on another tap's create names the series that tap made", async () => {
    const tx = await internet("2026-10-15");
    const result = await withClient(async (other) => {
      await other.query("BEGIN");
      const [{ id }] = (
        await other.query<{ id: number }>(
          "insert into recurring_series (name, kind, cadence) values ('Internet bill', 'expense', 'monthly') returning id",
        )
      ).rows;
      await other.query("update transactions set recurring_series_id = $1 where id = $2", [id, tx]);
      const second = rdb.createSeries({ transactionId: tx, name: "Internet bill", cadence: "monthly", amountVaries: false });
      await blockedOnLock();
      await other.query("COMMIT");
      return { id, second: await second };
    });
    expect(result.second).toEqual({ already: result.id, name: "Internet bill" });
    expect(await sql("select count(*)::int as n from recurring_series")).toEqual([{ n: 1 }]);
  });

  it("a pause that waits on the same pause from another tap is already paused, not an overlap", async () => {
    const sid = await created(await internet("2026-10-15"));
    const result = await withClient(async (other) => {
      await other.query("BEGIN");
      await other.query("insert into recurring_pauses (series_id, paused_from) values ($1, '2026-10-31')", [sid]);
      const second = rdb.pauseSeries(sid, "2026-10-31", null);
      await blockedOnLock();
      await other.query("COMMIT");
      return second;
    });
    expect(result).toBe("already");
    expect(await sql("select count(*)::int as n from recurring_pauses")).toEqual([{ n: 1 }]);
  });
});

describe("pauseSeries and resumeSeries", () => {
  it("writes one dated pause, repeats as already, refuses an overlap, and resumes on a date", async () => {
    const sid = await created(await internet("2026-10-15"));
    expect(await rdb.pauseSeries(sid, "2026-09-01", "2026-10-28")).toBe("paused");
    expect(await rdb.pauseSeries(sid, "2026-09-01", "2026-10-28")).toBe("already");
    expect(await rdb.pauseSeries(sid, "2026-10-01", null)).toBe("overlap");
    expect(await rdb.pauseSeries(sid, "2026-10-28", null)).toBe("paused");
    expect(await rdb.pauseSeries(999, "2026-10-28", null)).toBe("missing");

    expect(await rdb.resumeSeries(sid, "2026-11-05")).toBe(true);
    expect(await rdb.resumeSeries(sid, "2026-11-05")).toBe(false);
    const pauses = await sql("select paused_from::text as f, resumed_on::text as u from recurring_pauses order by 1");
    expect(pauses).toEqual([
      { f: "2026-09-01", u: "2026-10-28" },
      { f: "2026-10-28", u: "2026-11-05" },
    ]);
  });

  it("resuming on the day a pause began removes it", async () => {
    const sid = await created(await internet("2026-10-15"));
    await rdb.pauseSeries(sid, "2026-10-31", null);
    expect(await rdb.resumeSeries(sid, "2026-10-31")).toBe(true);
    expect(await sql("select count(*)::int as n from recurring_pauses")).toEqual([{ n: 0 }]);
  });
});

describe("renameSeries and deleteSeries", () => {
  it("renames, refuses a taken name, and reports a series that is gone", async () => {
    const sid = await created(await internet("2026-10-15"));
    await created(await insertTransaction({ date: "2026-10-03", amount: "25.00", description: "Gym" }), "Gym");
    expect(await rdb.renameSeries(sid, "Home internet")).toBe("renamed");
    expect(await rdb.renameSeries(sid, "gym")).toBe("taken");
    expect(await rdb.renameSeries(999, "Other")).toBe("missing");
    expect(await sql("select name from recurring_series order by id")).toEqual([{ name: "Home internet" }, { name: "Gym" }]);
  });

  it("deleting a series unlinks its payments, clears their flag, and a second delete finds nothing", async () => {
    const a = await internet("2026-09-15");
    const b = await internet("2026-10-15");
    const sid = await created(a);
    await rdb.applyReview(sid, [b], []);
    expect(await rdb.deleteSeries(sid)).toEqual({ name: "Internet bill", unlinked: 2 });
    expect(await links()).toEqual({ [a]: { series: null, flagged: false }, [b]: { series: null, flagged: false } });
    expect(await rdb.deleteSeries(sid)).toBeNull();
  });
});

describe("applyReview", () => {
  it("links the ticked rows, records an exclusion for the shown but unticked ones, and repeats as a no-op", async () => {
    const first = await internet("2026-08-15");
    const sid = await created(first);
    const ticked = await internet("2026-09-15");
    const unticked = await internet("2026-10-15");
    await sql("insert into recurring_exclusions (series_id, transaction_id) values ($1, $2)", [sid, ticked]);

    expect(await rdb.applyReview(sid, [ticked], [unticked])).toEqual({ linked: 1, ignored: 1 });
    expect((await links())[ticked]).toEqual({ series: sid, flagged: true });
    expect((await links())[unticked]).toEqual({ series: null, flagged: false });
    // The ticked row's old exclusion is cleared, so it is never both linked and excluded.
    expect(await exclusions()).toEqual([`${sid}:${unticked}`]);

    expect(await rdb.applyReview(sid, [ticked], [unticked])).toEqual({ linked: 0, ignored: 0 });
  });

  it("never takes a row from another series, never links another kind or income source, and never excludes its own member", async () => {
    const sid = await created(await internet("2026-08-15"));
    const gym = await insertTransaction({ date: "2026-10-03", amount: "25.00", description: "Gym" });
    const other = await created(gym, "Gym");
    const pay = await insertTransaction({ date: "2026-10-16", type: "income", amount: "2000.00", description: "Pay", source: "Salary" });
    const salary = await created(pay, "Salary");
    const refund = await insertTransaction({ date: "2026-10-20", type: "income", amount: "20.00", description: "Refund", source: "Refund" });
    const member = (await sql<{ id: string }>("select id::text from transactions where recurring_series_id = $1", [sid]))[0].id;

    expect(await rdb.applyReview(sid, [gym, pay], [member])).toEqual({ linked: 0, ignored: 0 });
    expect(await rdb.applyReview(salary, [refund], [])).toEqual({ linked: 0, ignored: 0 });
    expect((await links())[gym].series).toBe(other);
    expect((await links())[refund].series).toBeNull();
    expect(await exclusions()).toEqual([]);
  });

  it("does nothing when the series is gone", async () => {
    const tx = await internet("2026-10-15");
    expect(await rdb.applyReview(999, [tx], [])).toBeNull();
    expect((await links())[tx].series).toBeNull();
  });
});

describe("clearFlags and dismissGroup", () => {
  it("clears the flag only on picked rows in no series, once", async () => {
    const legacy = await internet("2026-09-15", { flagged: true });
    const kept = await internet("2026-09-20", { flagged: true });
    const linked = await internet("2026-10-15");
    await created(linked);

    expect(await rdb.clearFlags([legacy, linked])).toBe(1);
    expect(await rdb.clearFlags([legacy])).toBe(0);
    expect(await links()).toMatchObject({
      [legacy]: { flagged: false },
      [kept]: { flagged: true },
      [linked]: { flagged: true },
    });
  });

  it("records a dismissed group once", async () => {
    expect(await rdb.dismissGroup("desc:gym")).toBe(true);
    expect(await rdb.dismissGroup("desc:gym")).toBe(false);
    expect(await sql("select group_key from recurring_dismissed")).toEqual([{ group_key: "desc:gym" }]);
  });
});
