import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
});

useJourneys();

// A synthetic Quebec grocery receipt: chicken and bananas are zero-rated,
// the sparkling water carries the GQ code, and GST and QST print below.
const [receipt] = (golden("rules-mixed-receipt").recorded as { events: Record<string, unknown>[] }).events;
const quebec = {
  ...receipt,
  amount: "24.52",
  taxes: ["0.35", "0.70"],
  tip: null,
  items: (receipt.items as Record<string, unknown>[]).map(({ amount: _, ...line }, i) => ({
    ...line,
    price: ["9.99", "6.49", "6.99"][i],
    taxable: i === 2,
  })),
};

const lineAmounts = () =>
  sql<{ description: string; amount: string }>(
    `select i.description, i.amount::text from transaction_items i order by i.amount`,
  );

describe("tax and tip on a receipt", () => {
  it("a Quebec receipt puts GST and QST only on the taxed line, and an added tip is shared by price", async () => {
    gemini.extract = { events: [quebec] };
    await chat.photo();
    const card = chat.last().text;
    expect(card.split("\n")[0]).toBe("Expense · 2026-10-25 · CAD 24.52");
    expect(card).toContain("✓ lines 9.99 + 6.49 + 8.04 = 24.52");

    await chat.tap(chat.last(), "Edit");
    // The model only adds the tip; the bot recomputes the lines and the total.
    gemini.patch = { ...quebec, tip: "3.00" };
    await chat.text("I also left a 3.00 tip");
    const sent = JSON.parse(gemini.lastUserText[0]);
    expect(sent).toMatchObject({ amount: "24.52", taxes: ["0.35", "0.70"], tip: null });
    expect(sent.items[2]).toMatchObject({ price: "6.99", taxable: true });
    expect(sent.items[2].amount).toBeUndefined();

    const fixed = chat.last();
    expect(fixed.text.split("\n")[0]).toBe("Expense · 2026-10-25 · CAD 27.52");
    expect(fixed.text).toContain("✓ lines 11.27 + 7.32 + 8.93 = 27.52");
    await chat.tap(fixed, "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "27.52", lines: 3 }]);
    expect((await lineAmounts()).map((l) => l.amount)).toEqual(["7.32", "8.93", "11.27"]);
  });

  it("a receipt whose prices, taxes and tip do not add up to its total cannot be confirmed", async () => {
    gemini.extract = { events: [{ ...quebec, amount: "25.52" }] };
    await chat.photo();
    expect(chat.last().text).toContain("✗ lines sum 24.52 != header 25.52");
    expect(await ledger.ingestions()).toEqual([]);
  });
});
