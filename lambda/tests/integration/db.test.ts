import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Extraction } from "../../src/extraction.js";
import { closeHelpers, resetData, sql } from "./db-helpers.js";
import { expense, income, pending, transfer } from "./fixtures.js";

vi.mock("../../src/config.js", async () => {
  const { testDbUrl } = await import("./env.js");
  return { getConfig: async () => ({ databaseUrl: testDbUrl() }) };
});

const db = await import("../../src/db.js");

afterAll(async () => {
  await db.closePool();
  await closeHelpers();
});
beforeEach(resetData);

async function save(updateId: number, ...events: Extraction[]): Promise<string[]> {
  const result = await db.insertPendingIngestions(
    events.map((e, i) => pending(updateId, e, i)),
  );
  if (result === "duplicate") throw new Error("unexpected duplicate");
  return result.map((r) => r.id);
}

async function status(id: string): Promise<string> {
  const [row] = await sql<{ status: string }>(
    "select status from ingestions where id = $1",
    [id],
  );
  return row.status;
}

async function count(table: string): Promise<number> {
  const [row] = await sql<{ n: number }>(`select count(*)::int n from ${table}`);
  return row.n;
}

describe("insertPendingIngestions", () => {
  it("saves every event of one update as pending, in order", async () => {
    const ids = await save(100, expense(), income());
    const rows = await sql(
      "select id::text, event_index, status, source from ingestions order by event_index",
    );
    expect(rows).toEqual([
      { id: ids[0], event_index: 0, status: "pending", source: "text" },
      { id: ids[1], event_index: 1, status: "pending", source: "text" },
    ]);
  });

  it("rejects a retry that produced different event indexes", async () => {
    await save(101, expense());
    const retry = await db.insertPendingIngestions([pending(101, income(), 1)]);
    expect(retry).toBe("duplicate");
    expect(await count("ingestions")).toBe(1);
  });

  it("lets exactly one of two concurrent inserts of one update win", async () => {
    // Two module instances = two pools = two real connections racing.
    vi.resetModules();
    const a = await import("../../src/db.js");
    vi.resetModules();
    const b = await import("../../src/db.js");
    try {
      const results = await Promise.all([
        a.insertPendingIngestions([pending(102, expense(), 0)]),
        b.insertPendingIngestions([
          pending(102, income(), 1),
          pending(102, transfer(), 2),
        ]),
      ]);
      expect(results.filter((r) => r === "duplicate")).toHaveLength(1);
      const winner = results.find((r) => r !== "duplicate") as { id: string }[];
      const rows = await sql<{ id: string }>("select id::text from ingestions");
      expect(rows.map((r) => r.id).sort()).toEqual(winner.map((w) => w.id).sort());
    } finally {
      await a.closePool();
      await b.closePool();
    }
  });
});

describe("confirmIngestion", () => {
  it("writes an expense with its lines, tags, venue, merchant, funder and note", async () => {
    const [id] = await save(200, expense());
    await expect(db.confirmIngestion(id)).resolves.toBe("confirmed");

    const [tx] = await sql<{ id: string }>(
      `select t.id::text, t.occurred_on::text as date, t.type::text, t.amount::text,
              t.currency, t.description, t.notes, m.name as merchant, v.name as venue,
              f.name as funder, t.income_source_id, t.to_account_id
       from transactions t
       left join merchants m on m.id = t.merchant_id
       left join venues v on v.id = t.venue_id
       left join funding_sources f on f.id = t.funding_source_id`,
    );
    expect(tx).toEqual({
      id: expect.any(String),
      date: "2026-10-20",
      type: "expense",
      amount: "12.50",
      currency: "CAD",
      description: "groceries",
      notes: "stocking up",
      merchant: "Acme Mart",
      venue: "Supermarket",
      funder: "self",
      income_source_id: null,
      to_account_id: null,
    });

    const items = await sql(
      `select i.description, i.amount::text, s.name as subcategory,
              it.name as item_type, i.bucket::text
       from transaction_items i
       join subcategories s on s.id = i.subcategory_id
       left join item_types it on it.id = i.item_type_id
       order by i.amount`,
    );
    expect(items).toEqual([
      { description: "milk", amount: "4.50", subcategory: "Groceries", item_type: "Ingredients & Staples", bucket: "needs" },
      { description: "cookies", amount: "8.00", subcategory: "Groceries", item_type: "Snacks & Sweets", bucket: "wants" },
    ]);

    const tags = await sql(
      "select g.name from transaction_tags tt join tags g on g.id = tt.tag_id",
    );
    expect(tags).toEqual([{ name: "Social" }]);

    const [ing] = await sql(
      "select status, transaction_id::text from ingestions where id = $1",
      [id],
    );
    expect(ing).toEqual({ status: "confirmed", transaction_id: tx.id });
  });

  it("writes income with its source and no funder or lines", async () => {
    const [id] = await save(201, income());
    await db.confirmIngestion(id);
    const [tx] = await sql(
      `select t.type::text, s.name as source, t.funding_source_id
       from transactions t join income_sources s on s.id = t.income_source_id`,
    );
    expect(tx).toEqual({ type: "income", source: "Salary", funding_source_id: null });
    expect(await count("transaction_items")).toBe(0);
  });

  it("writes a transfer to its account", async () => {
    const [id] = await save(202, transfer());
    await db.confirmIngestion(id);
    const [tx] = await sql(
      `select t.type::text, a.name as account, t.funding_source_id
       from transactions t join accounts a on a.id = t.to_account_id`,
    );
    expect(tx).toEqual({ type: "transfer", account: "Emergency fund", funding_source_id: null });
  });

  it("records who paid when someone else funded it", async () => {
    const [id] = await save(203, expense({ funded_by: "family" }));
    await db.confirmIngestion(id);
    const [tx] = await sql(
      "select f.name as funder from transactions t join funding_sources f on f.id = t.funding_source_id",
    );
    expect(tx).toEqual({ funder: "family" });
  });

  it("saves a merchant that is not in the lookup as no merchant", async () => {
    const [id] = await save(204, expense({ merchant: "Corner Store" }));
    await expect(db.confirmIngestion(id)).resolves.toBe("confirmed");
    const [tx] = await sql("select merchant_id from transactions");
    expect(tx).toEqual({ merchant_id: null });
  });

  it("reports already handled on a second tap and writes one transaction", async () => {
    const [id] = await save(205, expense());
    await db.confirmIngestion(id);
    await expect(db.confirmIngestion(id)).resolves.toBe("already_handled");
    expect(await count("transactions")).toBe(1);
  });

  it("rejects a row that fails checks and writes nothing", async () => {
    const bad = expense({
      amount: "4.50",
      items: [{ ...expense().items[0], subcategory: "Nope" }],
    });
    const [id] = await save(206, bad);
    await expect(db.confirmIngestion(id)).rejects.toThrow(/failed checks/);
    expect(await count("transactions")).toBe(0);
    expect(await status(id)).toBe("pending");
  });

  it("will not confirm a discarded row", async () => {
    const [id] = await save(207, expense());
    await db.discardIngestion(id);
    await expect(db.confirmIngestion(id)).resolves.toBe("already_handled");
    expect(await count("transactions")).toBe(0);
  });
});

describe("discardIngestion", () => {
  it("discards a pending row once", async () => {
    const [id] = await save(250, expense());
    await expect(db.discardIngestion(id)).resolves.toBe("discarded");
    await expect(db.discardIngestion(id)).resolves.toBe("already_handled");
    expect(await status(id)).toBe("discarded");
  });

  it("leaves a confirmed row alone", async () => {
    const [id] = await save(251, expense());
    await db.confirmIngestion(id);
    await expect(db.discardIngestion(id)).resolves.toBe("already_handled");
    expect(await status(id)).toBe("confirmed");
  });
});

describe("waiting for a date or a correction", () => {
  it("routes a date reply to the waiting row and then stops waiting", async () => {
    const [a] = await save(300, expense());
    await expect(db.setIngestionAwaitingDate(a)).resolves.toBe("started");
    await expect(db.findAwaitingIngestion()).resolves.toMatchObject({
      id: a,
      status: "awaiting_date",
    });
    await expect(
      db.applyIngestionDate(a, expense({ date: "2026-10-01" })),
    ).resolves.toBe(true);
    const [row] = await sql(
      "select status, extraction->>'date' as date from ingestions where id = $1",
      [a],
    );
    expect(row).toEqual({ status: "pending", date: "2026-10-01" });
    await expect(db.findAwaitingIngestion()).resolves.toBeNull();
  });

  it("lets only one card wait at a time", async () => {
    const [a, b] = await save(301, expense(), income());
    await db.setIngestionAwaitingDate(a);
    await expect(db.setIngestionAwaitingDate(b)).resolves.toBe("busy");
    await expect(db.setIngestionAwaitingEdit(b)).resolves.toBe("busy");
    expect(await status(b)).toBe("pending");
  });

  it("applies a correction only while the row awaits an edit", async () => {
    const [a] = await save(302, expense());
    await expect(db.setIngestionAwaitingEdit(a)).resolves.toBe("started");
    await expect(db.applyIngestionDate(a, expense())).resolves.toBe(false);
    await expect(
      db.applyIngestionEdit(a, expense({ description: "fixed" })),
    ).resolves.toBe(true);
    const [row] = await sql(
      "select status, extraction->>'description' as description from ingestions where id = $1",
      [a],
    );
    expect(row).toEqual({ status: "pending", description: "fixed" });
  });

  it("reports already handled when the row is no longer pending", async () => {
    const [a] = await save(303, expense());
    await db.confirmIngestion(a);
    await expect(db.setIngestionAwaitingDate(a)).resolves.toBe("already_handled");
  });

  it("frees the wait when the waiting card is discarded", async () => {
    const [a, b] = await save(304, expense(), income());
    await db.setIngestionAwaitingDate(a);
    await db.discardIngestion(a);
    await expect(db.setIngestionAwaitingDate(b)).resolves.toBe("started");
  });
});

describe("listPendingIngestions", () => {
  async function saveFrom(chatId: number, updateId: number, ...events: Extraction[]) {
    const rawPayload = { update_id: updateId, message: { chat: { id: chatId } } };
    const result = await db.insertPendingIngestions(
      events.map((e, i) => ({ ...pending(updateId, e, i), rawPayload })),
    );
    if (result === "duplicate") throw new Error("unexpected duplicate");
    return result.map((r) => r.id);
  }

  it("lists the chat's pending rows oldest first, skipping handled, waiting and other chats' rows", async () => {
    const [a, confirmed] = await saveFrom(1001, 400, expense(), income());
    await db.confirmIngestion(confirmed);
    const [waiting] = await saveFrom(1001, 401, transfer());
    await db.setIngestionAwaitingDate(waiting);
    await saveFrom(2002, 402, expense({ description: "not yours" }));
    const [b, c] = await saveFrom(1001, 403, expense({ description: "later" }), income());

    const rows = await db.listPendingIngestions(1001);
    expect(rows.map((r) => [r.id, r.extraction.description])).toEqual([
      [a, "groceries"],
      [b, "later"],
      [c, "paycheque"],
    ]);
  });
});

describe("loadTaxonomy", () => {
  it("returns the generic seed plus the example overlay, nothing personal", async () => {
    const t = await db.loadTaxonomy();
    expect(t.incomeSources).toEqual(["Refund", "Salary"]);
    expect(t.accounts).toEqual(["Emergency fund", "Retirement account"]);
    expect(t.fundingSources).toEqual(["family", "self"]);
    expect(t.merchants).toEqual(["Acme Mart", "Example Online"]);
    expect(t.tags).toEqual(expect.arrayContaining(["Partner", "Social"]));
    expect(t.subcategories).toContainEqual({
      category: "Food and drink",
      name: "Takeout / Quick Service",
      default_bucket: "wants",
    });
  });
});
