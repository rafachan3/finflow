import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Extraction } from "../../src/extraction.js";
import { closeHelpers, resetData, sql } from "./db-helpers.js";
import { merchantKey } from "../../src/commands.js";
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

describe("findDuplicates", () => {
  let nextUpdate = 600;

  /** Saves one message from the owner's chat; a photo message carries its sizes' unique ids. */
  async function card(
    events: Extraction[],
    photo?: { file_unique_id: string; file_size: number }[],
  ): Promise<string[]> {
    const updateId = nextUpdate++;
    const message = photo ? { chat: { id: 1001 }, photo } : { chat: { id: 1001 } };
    const result = await db.insertPendingIngestions(
      events.map((e, i) => ({
        ...pending(updateId, e, i),
        source: photo ? ("photo" as const) : ("text" as const),
        rawPayload: { update_id: updateId, message },
      })),
    );
    if (result === "duplicate") throw new Error("unexpected duplicate");
    return result.map((r) => r.id);
  }

  async function confirmed(extraction: Extraction): Promise<string> {
    const [id] = await card([extraction]);
    await db.confirmIngestion(id);
    return id;
  }

  it("matches the same type and amount 3 days apart, but not 4", async () => {
    await confirmed(expense({ date: "2026-10-20" }));
    const [near] = await card([expense({ date: "2026-10-23" })]);
    expect(await db.findDuplicates(near)).toEqual([
      { rule: "amount", status: "saved", date: "2026-10-20", amount: "12.50", description: "groceries" },
    ]);

    await db.discardIngestion(near);
    const [far] = await card([expense({ date: "2026-10-24" })]);
    expect(await db.findDuplicates(far)).toEqual([]);
  });

  it("an income from another source does not match, the same source does", async () => {
    await confirmed(income());
    const [refund] = await card([income({ income_source: "Refund" })]);
    expect(await db.findDuplicates(refund)).toEqual([]);

    await db.discardIngestion(refund);
    const [salary] = await card([income({ date: "2026-10-22" })]);
    expect(await db.findDuplicates(salary)).toMatchObject([
      { rule: "amount", status: "saved", date: "2026-10-20", amount: "200.00" },
    ]);
  });

  it("a transfer matches", async () => {
    await confirmed(transfer());
    const [again] = await card([transfer({ date: "2026-10-21" })]);
    expect(await db.findDuplicates(again)).toMatchObject([
      { rule: "amount", status: "saved", amount: "50.00", description: "to savings" },
    ]);
  });

  it("finds confirmed and pending matches, nearest first and saved ahead of pending on a tie", async () => {
    await confirmed(expense({ date: "2026-10-20", description: "saved one" }));
    await card([expense({ date: "2026-10-20", description: "open one" })]);
    await card([expense({ date: "2026-10-23", description: "open nearer" })]);
    const [current] = await card([expense({ date: "2026-10-22" })]);

    expect(
      (await db.findDuplicates(current)).map((m) => [m.status, m.date, m.description]),
    ).toEqual([
      ["pending", "2026-10-23", "open nearer"],
      ["saved", "2026-10-20", "saved one"],
      ["pending", "2026-10-20", "open one"],
    ]);
  });

  it("events of the same message never match each other, saved or not", async () => {
    const [first, second] = await card([expense(), expense()]);
    expect(await db.findDuplicates(second)).toEqual([]);

    await db.confirmIngestion(first);
    expect(await db.findDuplicates(second)).toEqual([]);
  });

  it("a discarded card is not a match", async () => {
    const [dropped] = await card([expense()]);
    await db.discardIngestion(dropped);
    const [current] = await card([expense()]);
    expect(await db.findDuplicates(current)).toEqual([]);
  });

  it("a dateless card uses the day it was sent in Toronto, on either side", async () => {
    await confirmed(expense({ date: "2026-10-17" }));
    const [dateless] = await card([expense({ date: "", date_source: "missing" })]);
    // 02:00 UTC on the 21st is still the 20th in Toronto: 3 days from the 17th.
    await sql("update ingestions set created_at = '2026-10-21T02:00:00Z' where id = $1", [dateless]);
    expect(await db.findDuplicates(dateless)).toMatchObject([
      { status: "saved", date: "2026-10-17" },
    ]);

    const [dated] = await card([expense({ date: "2026-10-23" })]);
    expect(await db.findDuplicates(dated)).toMatchObject([
      { status: "pending", date: "2026-10-20" },
    ]);
  });

  it("a photo whose largest size was sent before matches by photo, ahead of amount matches", async () => {
    const sizes = (large: string) => [
      { file_unique_id: "small-u", file_size: 10 },
      { file_unique_id: large, file_size: 900 },
    ];
    const [first] = await card([expense({ amount: "30.00", items: [] })], sizes("large-u"));
    await sql("update ingestions set created_at = '2026-10-26T15:00:00Z' where id = $1", [first]);
    await confirmed(expense());

    const [again] = await card([expense()], sizes("large-u"));
    expect(await db.findDuplicates(again)).toMatchObject([
      { rule: "photo", status: "pending", date: "2026-10-26" },
      { rule: "amount", status: "saved" },
    ]);

    const [other] = await card([expense({ amount: "40.00" })], sizes("other-u"));
    expect(await db.findDuplicates(other)).toEqual([]);
  });
});

describe("merchants", () => {
  it("lists the visible merchants sorted by name, and counts the hidden ones", async () => {
    await sql("insert into merchants (name) values ('Maple Kiosk'), ('Old Shop')");
    await sql("update merchants set hidden_at = now() where name = 'Old Shop'");
    expect(await db.listMerchants()).toEqual({
      names: ["Acme Mart", "Example Online", "Maple Kiosk"],
      hidden: 1,
    });
  });

  it("adds a merchant with no aliases, and the next taxonomy load has it", async () => {
    expect(await db.addMerchant("Maple Kiosk")).toEqual({ added: "Maple Kiosk", unhid: false, linked: 0 });
    expect(await sql("select aliases from merchants where name = 'Maple Kiosk'")).toEqual([
      { aliases: [] },
    ]);
    expect((await db.loadTaxonomy()).merchants).toContain("Maple Kiosk");
  });

  it("will not add a name that matches a merchant in another case, and reports the existing spelling", async () => {
    expect(await db.addMerchant("acme MART")).toEqual({ exists: "Acme Mart", linked: 0 });
    expect(await db.addMerchant("Acme Mart")).toEqual({ exists: "Acme Mart", linked: 0 });
    expect(await count("merchants")).toBe(2);
  });

  it("deletes a merchant that no transaction uses, whatever the case", async () => {
    await db.addMerchant("Maple Kiosk");
    expect(await db.deleteMerchant("maple kiosk")).toEqual({ deleted: "Maple Kiosk" });
    expect((await db.listMerchants()).names).toEqual(["Acme Mart", "Example Online"]);
  });

  it("reports a name that is not a merchant", async () => {
    expect(await db.deleteMerchant("Nowhere")).toEqual({ missing: true });
    expect(await count("merchants")).toBe(2);
  });

  it("hides a merchant that saved transactions use: it keeps their links, leaves the taxonomy, and a later Confirm does not link it", async () => {
    const [a, b] = await save(901, expense({ merchant: "Acme Mart" }), expense({ merchant: "Acme Mart" }));
    await db.confirmIngestion(a);
    await db.confirmIngestion(b);
    expect(await db.deleteMerchant("ACME MART")).toEqual({ hidden: "Acme Mart", uses: 2 });
    expect(await db.listMerchants()).toEqual({ names: ["Example Online"], hidden: 1 });
    expect((await db.loadTaxonomy()).merchants).toEqual(["Example Online"]);

    const [c] = await save(902, expense({ merchant: "Acme Mart" }));
    await db.confirmIngestion(c);
    const rows = await sql<{ merchant: string | null }>(
      `select m.name as merchant from transactions t
       left join merchants m on m.id = t.merchant_id order by t.created_at`,
    );
    expect(rows.map((r) => r.merchant)).toEqual(["Acme Mart", "Acme Mart", null]);

    expect(await db.deleteMerchant("Acme Mart")).toEqual({ hidden: "Acme Mart", uses: 2 });
  });

  it("adding a hidden merchant's name, in any case, unhides it and links what was confirmed while hidden", async () => {
    await sql("update merchants set hidden_at = now() where name = 'Acme Mart'");
    const [a] = await save(903, expense({ merchant: "Acme Mart" }));
    await db.confirmIngestion(a);
    expect(await db.addMerchant("acme mart")).toEqual({ added: "Acme Mart", unhid: true, linked: 1 });
    expect(await sql("select count(*)::int n from transactions where merchant_id is null")).toEqual([{ n: 0 }]);
    expect(await db.listMerchants()).toEqual({ names: ["Acme Mart", "Example Online"], hidden: 0 });
    expect(await db.addMerchant("Acme Mart")).toEqual({ exists: "Acme Mart", linked: 0 });
  });

  it("adding a merchant links past transactions whose extraction names it, ignoring case and spaces, and leaves linked ones alone", async () => {
    const ids = await save(
      904,
      expense({ merchant: " maple   KIOSK " }),
      expense({ merchant: "Maple Kiosk" }),
      expense({ merchant: "Maple Kiosk" }),
      expense({ merchant: "Corner Store" }),
      expense({ merchant: null }),
    );
    for (const id of ids) await db.confirmIngestion(id);
    // The owner linked this one by hand to another merchant: it must stay.
    await sql(
      `update transactions set merchant_id = (select id from merchants where name = 'Acme Mart')
       where id = (select transaction_id from ingestions where id = $1)`,
      [ids[2]],
    );
    const [stillPending] = await save(905, expense({ merchant: "Maple Kiosk" }));

    expect(await db.addMerchant("Maple Kiosk")).toEqual({ added: "Maple Kiosk", unhid: false, linked: 2 });

    const rows = await sql<{ merchant: string | null }>(
      `select m.name as merchant from ingestions i
       join transactions t on t.id = i.transaction_id
       left join merchants m on m.id = t.merchant_id
       order by i.event_index`,
    );
    expect(rows.map((r) => r.merchant)).toEqual(["Maple Kiosk", "Maple Kiosk", "Acme Mart", null, null]);
    expect(await status(stillPending)).toBe("pending");
    expect(await db.addMerchant("maple kiosk")).toEqual({ exists: "Maple Kiosk", linked: 0 });
  });

  /** A Notion-style row: a saved transaction with no ingestion behind it. */
  async function imported(description: string, merchant: string | null = null): Promise<void> {
    await sql(
      `insert into transactions (occurred_on, type, amount, description, funding_source_id, merchant_id)
       values ('2026-07-01', 'expense', 9.99, $1,
               (select id from funding_sources where name = 'self'),
               (select id from merchants where name = $2))`,
      [description, merchant],
    );
  }

  async function merchantByDescription(): Promise<Record<string, string | null>> {
    const rows = await sql<{ description: string; merchant: string | null }>(
      `select t.description, m.name as merchant from transactions t
       left join merchants m on m.id = t.merchant_id order by t.created_at`,
    );
    return rows.map((r) => [r.description, r.merchant]).reduce((o, [d, m]) => ({ ...o, [d!]: m }), {});
  }

  it("adding a merchant links imported rows whose whole description is its name, typographic apostrophes and case aside", async () => {
    await imported("Joe\u2019s Diner");
    await imported("  JOE'S   diner ");
    await imported("Joe\u2019s Diner lunch");
    await imported("Joes Diner");
    await imported("Acme Mart lunch");
    await imported("Joe\u2019s Diner", "Acme Mart");

    expect(await db.addMerchant("Joe's Diner")).toEqual({ added: "Joe's Diner", unhid: false, linked: 2 });

    expect(await sql("select description, merchant_id is null as unlinked from transactions order by created_at")).toEqual([
      { description: "Joe\u2019s Diner", unlinked: false },
      { description: "  JOE'S   diner ", unlinked: false },
      { description: "Joe\u2019s Diner lunch", unlinked: true },
      { description: "Joes Diner", unlinked: true },
      { description: "Acme Mart lunch", unlinked: true },
      { description: "Joe\u2019s Diner", unlinked: false },
    ]);
  });

  it("never matches an imported row by part of its description", async () => {
    await imported("Metro ticket");
    await imported("Bixi Monthly Pass");
    await imported("Bixi");
    expect(await db.addMerchant("Metro")).toEqual({ added: "Metro", unhid: false, linked: 0 });
    expect(await db.addMerchant("Bixi")).toEqual({ added: "Bixi", unhid: false, linked: 1 });
    expect(await merchantByDescription()).toEqual({
      "Metro ticket": null,
      "Bixi Monthly Pass": null,
      Bixi: "Bixi",
    });
  });

  it("an imported-row match applies only to rows with no ingestion: a bot row is matched by its extraction", async () => {
    const [a] = await save(950, expense({ merchant: "Corner Store", description: "Joe's Diner" }));
    await db.confirmIngestion(a);
    expect(await db.addMerchant("Joe's Diner")).toEqual({ added: "Joe's Diner", unhid: false, linked: 0 });
  });

  it("links past transactions whose extraction names the merchant with a curly apostrophe", async () => {
    const [a, b] = await save(951, expense({ merchant: "Joe\u2019s Diner" }), expense({ merchant: "Joe\u2018s Diner" }));
    await db.confirmIngestion(a);
    await db.confirmIngestion(b);
    expect(await db.addMerchant("Joe's Diner")).toEqual({ added: "Joe's Diner", unhid: false, linked: 2 });
  });

  it("adding a name that exists links what is still unlinked and reports the count", async () => {
    await imported("Acme Mart");
    await imported("acme mart");
    expect(await db.addMerchant("ACME MART")).toEqual({ exists: "Acme Mart", linked: 2 });
    expect(await db.addMerchant("Acme Mart")).toEqual({ exists: "Acme Mart", linked: 0 });
  });

  it("a name differing only by apostrophe style is the same merchant", async () => {
    await sql("insert into merchants (name) values ('Joe\u2019s Diner')");
    await imported("Joe's Diner");
    expect(await db.addMerchant("Joe's Diner")).toEqual({ exists: "Joe\u2019s Diner", linked: 1 });
    expect(await count("merchants")).toBe(3);
    expect(await db.deleteMerchant("JOE'S DINER")).toEqual({ hidden: "Joe\u2019s Diner", uses: 1 });
  });

  it("Confirm links a merchant named with another apostrophe style, but not a hidden one", async () => {
    await sql("insert into merchants (name) values ('Joe''s Diner')");
    const [a] = await save(952, expense({ merchant: "Joe\u2019s Diner" }));
    await db.confirmIngestion(a);
    expect(await sql("select m.name from transactions t join merchants m on m.id = t.merchant_id")).toEqual([
      { name: "Joe's Diner" },
    ]);
  });

  it("the TypeScript key and the SQL key agree", async () => {
    const samples = ["McDonald\u2019s", " MCDONALD'S ", "a\u2018b`c\u00b4d", "Caf\u00e9   Nuit", "Acme\tMart\n", "", "O\u2019Brien\u2019s  BAR"];
    for (const raw of samples) {
      const [row] = await sql<{ key: string }>(`select ${db.MERCHANT_KEY("$1::text")} as key`, [raw]);
      expect(row.key, JSON.stringify(raw)).toBe(merchantKey(raw));
    }
  });
});

describe("findFrequentMerchant", () => {
  let nextUpdate = 700;

  async function saveOne(extraction: Extraction): Promise<string> {
    const [id] = await save(nextUpdate++, extraction);
    return id;
  }

  /** Confirms `n` purchases, one message each, naming the merchant as typed. */
  async function bought(merchant: string | null, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await db.confirmIngestion(await saveOne(expense({ merchant })));
  }

  it("counts confirmed purchases that name the card's merchant, ignoring case and spaces", async () => {
    await bought("maple   KIOSK", 1);
    await bought(" Maple Kiosk ", 2);
    await bought("Corner Store", 5);
    const card = await saveOne(expense({ merchant: "Maple  Kiosk" }));

    expect(await db.findFrequentMerchant(card, 3)).toEqual({ name: "Maple Kiosk", count: 3 });
  });

  it("is empty below the minimum, and counts neither pending, discarded nor the card's own update", async () => {
    await bought("Maple Kiosk", 2);
    await saveOne(expense({ merchant: "Maple Kiosk" }));
    await db.discardIngestion(await saveOne(expense({ merchant: "Maple Kiosk" })));
    // Two events of one message: confirmed or not, they never count each other.
    const [a, b] = await save(nextUpdate++, expense({ merchant: "Maple Kiosk" }), expense({ merchant: "Maple Kiosk" }));
    await db.confirmIngestion(b);

    expect(await db.findFrequentMerchant(a, 3)).toBeNull();
    expect(await db.findFrequentMerchant(a, 2)).toEqual({ name: "Maple Kiosk", count: 2 });
  });

  it("is empty for a merchant in the lookup, in any case, and for a hidden one", async () => {
    await bought("Acme Mart", 3);
    await bought("Example Online", 3);
    expect(await db.findFrequentMerchant(await saveOne(expense({ merchant: "Acme Mart" })), 3)).toBeNull();
    expect(await db.findFrequentMerchant(await saveOne(expense({ merchant: "acme  MART" })), 3)).toBeNull();

    await sql("update merchants set hidden_at = now() where name = 'Example Online'");
    expect(await db.findFrequentMerchant(await saveOne(expense({ merchant: "Example Online" })), 3)).toBeNull();
  });

  it("counts apostrophe styles as one name, and finds a lookup row spelled with another", async () => {
    await bought("Joe’s Diner", 1);
    await bought("JOE'S DINER", 2);
    expect(await db.findFrequentMerchant(await saveOne(expense({ merchant: "Joe‘s Diner" })), 3)).toEqual({
      name: "Joe‘s Diner",
      count: 3,
    });
    await sql("insert into merchants (name) values ('Joe’s Diner')");
    expect(await db.findFrequentMerchant(await saveOne(expense({ merchant: "Joe's Diner" })), 3)).toBeNull();
  });

  it("is empty for a card with no merchant", async () => {
    await bought("Maple Kiosk", 3);
    expect(await db.findFrequentMerchant(await saveOne(expense({ merchant: null })), 3)).toBeNull();
  });

  it("stops once the merchant is added", async () => {
    await bought("Maple Kiosk", 3);
    const card = await saveOne(expense({ merchant: "Maple Kiosk" }));
    expect(await db.findFrequentMerchant(card, 3)).not.toBeNull();
    await db.addMerchant("Maple Kiosk");
    expect(await db.findFrequentMerchant(card, 3)).toBeNull();
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
