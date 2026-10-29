import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, labels, ledger, STRANGER, useJourneys, type Reply } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const check = (n: number) => `Check ${n} that mention${n === 1 ? "s" : ""} Maple Kiosk. Tap to pick, then Link:`;
const ACTIONS = ["Link selected", "Select all", "Skip"];

/** The replies one message produced. */
async function send(text: string): Promise<Reply[]> {
  const before = chat.replies().length;
  await chat.text(text);
  return chat.replies().slice(before);
}

async function merchants(): Promise<Record<string, string | null>> {
  const rows = await ledger.transactions();
  return Object.fromEntries(rows.map((r) => [String(r.description), r.merchant as string | null]));
}

/** A saved text purchase whose extraction named no merchant: only the owner's words mention one. */
async function savedText(text: string, description: string): Promise<void> {
  const recorded = golden("text-with-note").recorded as { events: object[] };
  gemini.extract = { events: [{ ...recorded.events[0], merchant: null, description }] };
  await chat.text(text);
  await chat.tap(chat.last(), "Confirm");
}

describe("/addmerchant review of transactions that mention the merchant", () => {
  it("links exact names at once, and offers mentions in a message, caption or description one by one", async () => {
    await ledger.importRow("Maple Kiosk");
    await ledger.importRow("Coffee at Maple Kiosk downtown");
    await savedText("14 lunch, the one by maple kiosk", "Lunch");

    const [added, review] = await send("/addmerchant Maple Kiosk");
    expect(added.text).toBe(
      "Added merchant: Maple Kiosk. Linked 1 past transaction that names it exactly. The next message will use it.",
    );
    expect(review.text).toBe(check(2));
    expect(labels(review)).toEqual([
      '☐ Oct 25 · 14.00 · "…lunch, the one by maple kiosk"',
      '☐ Jul 1 · 9.99 · "Coffee at Maple Kiosk downtown"',
      ...ACTIONS,
    ]);
    expect(await merchants()).toEqual({
      "Maple Kiosk": "Maple Kiosk",
      "Coffee at Maple Kiosk downtown": null,
      Lunch: null,
    });
  });

  it("a tap ticks a mention without writing, and Link selected links only the ticked ones", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    await ledger.importRow("Maple Kiosk muffin");
    const [, review] = await send("/addmerchant Maple Kiosk");

    await chat.tap(review, '☐ Jul 1 · 9.99 · "Maple Kiosk muffin"');
    // Newest first: the later import heads the list.
    expect(labels(chat.current(review))).toEqual([
      '✅ Jul 1 · 9.99 · "Maple Kiosk muffin"',
      '☐ Jul 1 · 9.99 · "Coffee at Maple Kiosk"',
      ...ACTIONS,
    ]);
    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": null, "Maple Kiosk muffin": null });

    // A second tap unticks, a third ticks again.
    await chat.tap(review, '✅ Jul 1 · 9.99 · "Maple Kiosk muffin"');
    await chat.tap(review, '☐ Jul 1 · 9.99 · "Maple Kiosk muffin"');
    await chat.tap(review, "Link selected");

    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": null, "Maple Kiosk muffin": "Maple Kiosk" });
    expect(chat.current(review)).toMatchObject({ text: "Linked 1 of 2 to Maple Kiosk.", buttons: [] });
  });

  it("Select all ticks every mention, and Link selected links them all", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    await ledger.importRow("Maple Kiosk muffin");
    const [, review] = await send("/addmerchant Maple Kiosk");

    await chat.tap(review, "Select all");
    expect(labels(chat.current(review)).filter((l) => l.startsWith("✅"))).toHaveLength(2);
    await chat.tap(review, "Link selected");

    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": "Maple Kiosk", "Maple Kiosk muffin": "Maple Kiosk" });
    expect(chat.current(review)).toMatchObject({ text: "Linked 2 of 2 to Maple Kiosk.", buttons: [] });
  });

  it("Link selected with nothing ticked asks for a pick and writes nothing", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    const [, review] = await send("/addmerchant Maple Kiosk");

    await chat.tap(review, "Link selected");
    expect(chat.acks().at(-1)).toBe("Tap the ones to link first, or Skip.");
    expect(labels(chat.current(review))).toHaveLength(4);
    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": null });
  });

  it("Skip removes the buttons and writes nothing", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    const [, review] = await send("/addmerchant Maple Kiosk");

    await chat.tap(review, "Select all");
    await chat.tap(review, "Skip");
    expect(chat.current(review)).toMatchObject({ text: check(1), buttons: [] });
    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": null });
  });

  it("matches the name as a whole word or phrase, not inside a longer word", async () => {
    await ledger.importRow("Metropolitan museum");
    await ledger.importRow("Metro ticket");
    await ledger.importRow("groceries (metro)");

    const [added, review] = await send("/addmerchant Metro");
    expect(added.text).toBe("Added merchant: Metro. The next message will use it.");
    expect(labels(review)).toEqual([
      '☐ Jul 1 · 9.99 · "groceries (metro)"',
      '☐ Jul 1 · 9.99 · "Metro ticket"',
      ...ACTIONS,
    ]);
  });

  it("a transaction that already has a merchant is never offered", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    await sql("update transactions set merchant_id = (select id from merchants where name = 'Acme Mart')");

    expect((await send("/addmerchant Maple Kiosk")).map((r) => r.text)).toEqual([
      "Added merchant: Maple Kiosk. The next message will use it.",
    ]);
  });

  it("a mention linked elsewhere between the offer and the tap keeps its merchant", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    await ledger.importRow("Maple Kiosk muffin");
    const [, review] = await send("/addmerchant Maple Kiosk");
    await chat.tap(review, "Select all");
    await sql(
      `update transactions set merchant_id = (select id from merchants where name = 'Acme Mart')
       where description = 'Maple Kiosk muffin'`,
    );

    await chat.tap(review, "Link selected");
    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": "Maple Kiosk", "Maple Kiosk muffin": "Acme Mart" });
    expect(chat.current(review).text).toBe("Linked 1 of 2 to Maple Kiosk. 1 already had a merchant.");
  });

  it("a mention offered for a merchant deleted before the tap is not linked", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    const [, review] = await send("/addmerchant Maple Kiosk");
    await chat.text("/delmerchant Maple Kiosk");

    await chat.tap(review, "Select all");
    await chat.tap(review, "Link selected");
    expect(chat.current(review)).toMatchObject({
      text: "Nothing linked: that merchant was deleted or hidden.",
      buttons: [],
    });
    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": null });
  });

  it("shows 8 mentions at a time; More sends the next ones and leaves the first message's picks alone", async () => {
    for (let n = 1; n <= 10; n++) await ledger.importRow(`Maple Kiosk visit ${n}`);
    const [, first] = await send("/addmerchant Maple Kiosk");
    expect(first.text).toBe(check(10));
    expect(labels(first)).toHaveLength(8 + ACTIONS.length + 1);
    expect(labels(first).at(-1)).toBe("More ›");

    await chat.tap(first, labels(first)[0]);
    await chat.tap(first, "More ›");
    const second = chat.last();
    expect(second.text).toBe("Check 2 more that mention Maple Kiosk. Tap to pick, then Link:");
    expect(labels(second)).toHaveLength(2 + ACTIONS.length);
    expect(labels(chat.current(first))).not.toContain("More ›");
    expect(labels(chat.current(first))[0]).toMatch(/^✅/);

    // The pages hold different rows.
    const shown = [...labels(chat.current(first)).slice(0, 8), ...labels(second).slice(0, 2)];
    expect(new Set(shown.map((l) => l.slice(2))).size).toBe(10);

    await chat.tap(second, "Select all");
    await chat.tap(second, "Link selected");
    await chat.tap(first, "Link selected");
    expect(Object.values(await merchants()).filter((m) => m === "Maple Kiosk")).toHaveLength(3);
  });

  it("More says so when the rest were linked in the meantime", async () => {
    for (let n = 1; n <= 9; n++) await ledger.importRow(`Maple Kiosk visit ${n}`);
    const [, first] = await send("/addmerchant Maple Kiosk");
    await sql(
      `update transactions set merchant_id = (select id from merchants where name = 'Acme Mart')
       where description = 'Maple Kiosk visit 1'`,
    );

    await chat.tap(first, "More ›");
    expect(chat.last().text).toBe("Nothing more to check.");
    expect(labels(chat.current(first))).not.toContain("More ›");
  });

  it("a review tap from a chat that is not on the allowlist does nothing", async () => {
    await ledger.importRow("Coffee at Maple Kiosk");
    const [, review] = await send("/addmerchant Maple Kiosk");
    const before = chat.acks().length;

    await chat.tap(review, "Select all", STRANGER);
    await chat.tap(review, "Link selected", STRANGER);
    expect(chat.acks()).toHaveLength(before);
    expect(labels(chat.current(review))[0]).toMatch(/^☐/);
    expect(await merchants()).toEqual({ "Coffee at Maple Kiosk": null });
  });
});
