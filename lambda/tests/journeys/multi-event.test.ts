import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { BUCKET, chat, gemini, labels, ledger, uploads, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const REVIEW = ["Confirm", "Discard", "Fix date", "Edit"];

describe("several purchases in one message", () => {
  it("two stores become two labelled cards, each saved on its own Confirm", async () => {
    gemini.extract = golden("two-stores").recorded;
    await chat.text("3 at Dollar Corner and 5 at Corner Pharmacy");

    const [first, second] = chat.replies();
    expect(chat.replies()).toHaveLength(2);
    expect(first.text.split("\n")[0]).toMatch(/CAD 3\.00 \(1 of 2\)$/);
    expect(second.text.split("\n")[0]).toMatch(/CAD 5\.00 \(2 of 2\)$/);
    expect(labels(first)).toEqual(REVIEW);
    expect(labels(second)).toEqual(REVIEW);

    await chat.tap(first, "Confirm");
    await chat.tap(second, "Confirm");
    expect(chat.acks()).toEqual(["Saved. (1 of 2)", "Saved. (2 of 2)"]);
    const saved = await ledger.transactions();
    expect(saved.map((t) => t.amount)).toEqual(["3.00", "5.00"]);
  });

  it("discarding the second of two cards says which one, in the toast and the chat", async () => {
    gemini.extract = golden("two-stores").recorded;
    await chat.text("3 at Dollar Corner and 5 at Corner Pharmacy");

    await chat.tap(chat.replies()[1], "Discard");
    expect(chat.acks()).toEqual(["Discarded. (2 of 2)"]);
    expect(chat.last().text).toBe("Discarded. (2 of 2)");
  });

  it("two items at one store stay one card with two lines", async () => {
    const recorded = golden("same-place-lines").recorded as {
      events: { items: object[] }[];
    };
    const [event] = recorded.events;
    gemini.extract = {
      events: [{ ...event, items: [{ ...event.items[0], bucket: "needs" }, event.items[1]] }],
    };
    await chat.text("milk 4 and bread 3 at Fresh Market");

    expect(chat.replies()).toHaveLength(1);
    const card = chat.last();
    expect(card.text).not.toMatch(/of \d\)/);
    expect(card.text).toContain("• Milk — 4.00");
    expect(card.text).toContain("• Bread — 3.00");

    await chat.tap(card, "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "7.00", lines: 2 }]);
    expect(await ledger.items()).toMatchObject([
      { description: "Bread", bucket: "wants" },
      { description: "Milk", bucket: "needs" },
    ]);
  });

  it("two items with no place stay one card with two lines", async () => {
    gemini.extract = golden("no-place-lines").recorded;
    await chat.text("12 lunch and 4 coffee");

    expect(chat.replies()).toHaveLength(1);
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "16.00", lines: 2 }]);
  });

  it("a purchase and a paycheque become an expense card and an income card", async () => {
    gemini.extract = golden("expense-and-income").recorded;
    await chat.text("groceries at Fresh Market 40, and got paid 200 salary");

    const [expense, income] = chat.replies();
    expect(expense.text).toMatch(/^Expense · .* \(1 of 2\)/);
    expect(income.text).toMatch(/^Income · .* \(2 of 2\)/);
    expect(income.text).toContain("Income source: Salary");

    await chat.tap(expense, "Confirm");
    await chat.tap(income, "Confirm");
    expect(await ledger.transactions()).toMatchObject([
      { type: "expense", amount: "40.00", funder: "self", lines: 1 },
      { type: "income", amount: "200.00", income_source: "Salary", funder: null, lines: 0 },
    ]);
  });

  it("a receipt with a caption purchase becomes two cards sharing one archived photo", async () => {
    gemini.extract = golden("receipt-with-caption").recorded;
    await chat.photo("also 5 at Corner Pharmacy");

    expect(chat.replies()).toHaveLength(2);
    const rows = await ledger.ingestions();
    expect(rows.map((r) => [r.event_index, r.source])).toEqual([
      [0, "photo"],
      [1, "photo"],
    ]);
    expect(uploads()).toEqual([
      expect.objectContaining({ Bucket: BUCKET, Key: rows[0].media_path, ContentType: "image/jpeg" }),
    ]);
    expect(rows[1].media_path).toBe(rows[0].media_path);
  });

  it("an event that fails checks is shown without buttons and is not saved", async () => {
    const [good, other] = (golden("two-stores").recorded as { events: object[] }).events;
    gemini.extract = {
      events: [good, { ...other, items: [{ ...(other as { items: object[] }).items[0], subcategory: "Not a subcategory" }] }],
    };
    await chat.text("3 at Dollar Corner and 5 at Corner Pharmacy");

    const [first, second] = chat.replies();
    expect(labels(first)).toEqual(REVIEW);
    expect(second.buttons).toEqual([]);
    expect(second.text).toContain("✗ unknown Health and wellness / Not a subcategory");
    expect(await ledger.ingestions()).toHaveLength(1);
  });

  it("Telegram resending the same message saves nothing new and sends no new cards", async () => {
    gemini.extract = golden("two-stores").recorded;
    await chat.text("3 at Dollar Corner and 5 at Corner Pharmacy");
    const result = await chat.retry();

    expect(result.body).toBe("duplicate");
    expect(chat.replies()).toHaveLength(2);
    expect(await ledger.ingestions()).toHaveLength(2);
  });
});
