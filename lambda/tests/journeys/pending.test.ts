import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const header = (text: string) => text.split("\n")[0];

async function twoCards() {
  gemini.extract = golden("two-stores").recorded;
  await chat.text("3 at Dollar Corner and 5 at Corner Pharmacy");
  return chat.replies();
}

/** The replies one message produced. */
async function send(text: string) {
  const before = chat.replies().length;
  await chat.text(text);
  return chat.replies().slice(before);
}

describe("/pending", () => {
  it("a card that never arrived comes back with /pending and can be confirmed", async () => {
    chat.failNextSends(1);
    expect(await twoCards()).toHaveLength(1);

    const resent = await send("/pending");
    expect(resent.map((r) => header(r.text))).toEqual([
      expect.stringMatching(/ · CAD 3\.00$/),
      expect.stringMatching(/ · CAD 5\.00$/),
    ]);
    expect(labels(resent[0])).toEqual(["Confirm", "Discard", "Fix date", "Edit"]);
    expect(gemini.calls).toHaveLength(1);

    await chat.tap(resent[0], "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "3.00" }]);
    const again = await send("/pending");
    expect(again.map((r) => header(r.text))).toEqual([expect.stringMatching(/ · CAD 5\.00$/)]);
  });

  it("with nothing pending, /pending says so and asks Gemini nothing", async () => {
    expect((await send("/pending")).map((r) => r.text)).toEqual(["No pending cards."]);
    expect((await send("/pending@any_bot")).map((r) => r.text)).toEqual(["No pending cards."]);
    expect(gemini.calls).toEqual([]);
    expect(await ledger.ingestions()).toEqual([]);
  });

  it("/pending while a card waits for a date resends the others and the wait goes on", async () => {
    const [first] = await twoCards();
    await chat.tap(first, "Fix date");

    const resent = await send("/pending");
    expect(resent.map((r) => header(r.text))).toEqual([expect.stringMatching(/ · CAD 5\.00$/)]);
    expect((await ledger.ingestions()).map((r) => r.status)).toEqual(["awaiting_date", "pending"]);

    await chat.text("2026-10-01");
    expect(header(chat.last().text)).toBe("Expense · 2026-10-01 · CAD 3.00");
    expect(gemini.calls).toHaveLength(1);
  });

  it("a resent card that fails to send does not stop the next one", async () => {
    await twoCards();
    chat.failNextSends(1);

    const resent = await send("/pending");
    expect(resent.map((r) => header(r.text))).toEqual([expect.stringMatching(/ · CAD 5\.00$/)]);
  });
});
