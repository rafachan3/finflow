import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const ASK_DATE = "Send the date as YYYY-MM-DD, Aug 10, or yesterday.";
const BUSY =
  "Another card is waiting for a date or correction. Send it, or tap Discard on that card, then try again.";

async function twoCards() {
  gemini.extract = golden("two-stores").recorded;
  await chat.text("3 at Dollar Corner and 5 at Corner Pharmacy");
  return chat.replies();
}

describe("a card waiting for a date", () => {
  it("Fix date asks for the date, and the reply brings the card back with Confirm", async () => {
    const [first] = await twoCards();
    await chat.tap(first, "Fix date");
    expect(chat.acks()).toEqual(["Send the date."]);
    expect(chat.last().text).toBe(ASK_DATE);
    expect(labels(chat.last())).toEqual(["Discard", "Fix date"]);

    await chat.text("2026-10-01");
    const fixed = chat.last();
    expect(fixed.text.split("\n")[0]).toBe("Expense · 2026-10-01 · CAD 3.00");
    await chat.tap(fixed, "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ date: "2026-10-01", amount: "3.00" }]);
  });

  it("Confirm on card 2 while card 1 waits for a date saves card 2 normally", async () => {
    const [first, second] = await twoCards();
    await chat.tap(first, "Fix date");
    await chat.tap(second, "Confirm");

    expect(chat.acks()).toEqual(["Send the date.", "Saved."]);
    expect(await ledger.transactions()).toMatchObject([{ amount: "5.00" }]);
  });

  it("Fix date on card 2 while card 1 waits says to finish the waiting card first", async () => {
    const [first, second] = await twoCards();
    await chat.tap(first, "Fix date");
    await chat.tap(second, "Fix date");

    expect(chat.acks()).toEqual(["Send the date.", "Finish the waiting card first."]);
    expect(chat.last().text).toBe(BUSY);
    const rows = await ledger.ingestions();
    expect(rows.map((r) => r.status)).toEqual(["awaiting_date", "pending"]);
  });

  it("Edit on card 2 while card 1 waits says the same", async () => {
    const [first, second] = await twoCards();
    await chat.tap(first, "Fix date");
    await chat.tap(second, "Edit");

    expect(chat.acks()).toEqual(["Send the date.", "Finish the waiting card first."]);
    expect(chat.last().text).toBe(BUSY);
  });

  it("a reply that is not a date asks again and changes nothing", async () => {
    const [first] = await twoCards();
    await chat.tap(first, "Fix date");
    await chat.text("whenever");

    expect(chat.last().text).toMatch(/^Still waiting for a date for the previous item/);
    expect((await ledger.ingestions())[0].status).toBe("awaiting_date");
  });

  it("a photo sent while a card waits is not read, and the bot asks for the date", async () => {
    const [first] = await twoCards();
    await chat.tap(first, "Fix date");
    const callsBefore = gemini.calls.length;
    await chat.photo();

    expect(gemini.calls).toHaveLength(callsBefore);
    expect(chat.last().text).toMatch(/^Still waiting for a date/);
  });

  it("discarding the waiting card lets another card wait", async () => {
    const [first, second] = await twoCards();
    await chat.tap(first, "Fix date");
    await chat.tap(first, "Discard");
    await chat.tap(second, "Fix date");

    expect(chat.acks()).toEqual(["Send the date.", "Discarded.", "Send the date."]);
  });
});
