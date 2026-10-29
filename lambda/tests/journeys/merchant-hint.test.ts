import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const HINT = "💡 You've bought from Maple Kiosk 3 times. Send /addmerchant Maple Kiosk to track it.";

/** The merchant hint lines of a card. */
function hints(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("💡"));
}

/** Gemini reads a purchase at `merchant`, whatever the lookup holds. */
function geminiReadsMerchant(merchant: string) {
  const recorded = golden("text-with-note").recorded as { events: object[] };
  gemini.extract = { events: [{ ...recorded.events[0], merchant }] };
}

/** Logs and confirms `n` purchases at `merchant`. */
async function buy(merchant: string, n: number) {
  geminiReadsMerchant(merchant);
  for (let i = 0; i < n; i++) {
    await chat.text(`14 lunch at ${merchant}`);
    await chat.tap(chat.last(), "Confirm");
  }
}

/** Logs one more purchase at `merchant` and returns its card. */
async function card(merchant: string) {
  geminiReadsMerchant(merchant);
  await chat.text(`14 lunch at ${merchant}`);
  return chat.last();
}

describe("frequent merchant hint", () => {
  it("a card whose merchant three saved purchases name, and no merchant row, suggests /addmerchant and keeps Confirm", async () => {
    await buy("Maple Kiosk", 2);
    expect(hints((await card("Maple Kiosk")).text)).toEqual([]);
    await chat.tap(chat.last(), "Discard");

    await buy("maple   KIOSK", 1);
    const shown = await card("Maple Kiosk");
    expect(hints(shown.text)).toEqual([HINT]);
    expect(shown.text).toContain("Confirm to save");
    expect(labels(shown)).toEqual(["Confirm", "Discard", "Fix date", "Edit"]);

    // A card resent by /pending carries the same hint.
    const before = chat.replies().length;
    await chat.text("/pending");
    expect(chat.replies().slice(before).map((r) => hints(r.text))).toEqual([[HINT]]);
  });

  it("two saved purchases are not enough", async () => {
    await buy("Maple Kiosk", 2);
    expect(hints((await card("Maple Kiosk")).text)).toEqual([]);
  });

  it("a merchant already in the lookup gets no hint, however often it was bought", async () => {
    await buy("Acme Mart", 3);
    expect(hints((await card("Acme Mart")).text)).toEqual([]);
  });

  it("a hidden merchant gets no hint: hiding it was the owner's choice", async () => {
    await chat.text("/addmerchant Maple Kiosk");
    await buy("Maple Kiosk", 3);
    await chat.text("/delmerchant Maple Kiosk");
    expect(hints((await card("Maple Kiosk")).text)).toEqual([]);
  });

  it("a card with no merchant gets no hint", async () => {
    await buy("Maple Kiosk", 3);
    const recorded = golden("text-with-note").recorded as { events: object[] };
    gemini.extract = { events: [{ ...recorded.events[0], merchant: null }] };
    await chat.text("14 lunch somewhere");
    expect(hints(chat.last().text)).toEqual([]);
  });

  it("sending /addmerchant for the hint, then Confirm on the same card, links the merchant", async () => {
    await buy("Maple Kiosk", 3);
    const shown = await card("Maple Kiosk");
    expect(hints(shown.text)).toEqual([HINT]);
    expect(await ledger.transactions()).toMatchObject([
      { merchant: null },
      { merchant: null },
      { merchant: null },
    ]);

    await chat.text("/addmerchant Maple Kiosk");
    expect(chat.last().text).toBe(
      "Added merchant: Maple Kiosk. Linked 3 past transactions. The next message will use it.",
    );

    await chat.tap(shown, "Confirm");
    expect(await ledger.transactions()).toMatchObject([
      { merchant: "Maple Kiosk" },
      { merchant: "Maple Kiosk" },
      { merchant: "Maple Kiosk" },
      { merchant: "Maple Kiosk" },
    ]);

    // Now a merchant: the next card has no hint.
    expect(hints((await card("Maple Kiosk")).text)).toEqual([]);
  });
});
