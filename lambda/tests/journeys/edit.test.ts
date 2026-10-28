import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const ASK_EDIT = "Send the correction — amount, category, a line, whatever is wrong.";

async function lunchCard() {
  gemini.extract = golden("text-with-note").recorded;
  await chat.text("14 lunch at Sandwich Shop on Oct 25, was to tierd didnt pak lunch");
  return chat.last();
}

describe("correcting a card with Edit", () => {
  it("Edit asks for the correction, and the corrected card saves the new amount", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    expect(chat.acks()).toEqual(["Send the correction."]);
    expect(chat.last().text).toBe(ASK_EDIT);
    expect(labels(chat.last())).toEqual(["Discard"]);

    gemini.patch = golden("edit-amount").recorded;
    await chat.text("it was 14.50");
    const fixed = chat.last();
    expect(fixed.text.split("\n")[0]).toBe("Expense · 2026-10-25 · CAD 14.50");
    expect(fixed.text).toContain("Note: I was too tired and didn't pack lunch.");

    await chat.tap(fixed, "Confirm");
    expect(await ledger.transactions()).toMatchObject([
      { amount: "14.50", date: "2026-10-25", notes: "I was too tired and didn't pack lunch." },
    ]);
  });

  it("an Edit that says a line is a need changes its bucket in one request", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    const patched = golden("edit-amount").recorded as { items: object[] };
    gemini.patch = {
      ...patched,
      items: [{ ...patched.items[0], bucket_why: "owner says it is a need", bucket: "needs" }],
    };
    const callsBefore = gemini.calls.length;
    await chat.text("that one is a need");

    expect(gemini.calls.slice(callsBefore)).toEqual([{ model: "gemini-3.6-flash", kind: "patch" }]);
    const fixed = chat.last();
    expect(fixed.text).toContain("/ needs");
    expect(fixed.text).toContain("owner says it is a need");

    await chat.tap(fixed, "Confirm");
    expect(await ledger.items()).toMatchObject([{ bucket: "needs" }]);
  });

  it("an Edit that calls one receipt line a need saves that change and keeps the other lines", async () => {
    gemini.extract = golden("rules-mixed-receipt").recorded;
    await chat.photo();
    await chat.tap(chat.last(), "Edit");
    gemini.patch = golden("rules-edit-need").recorded;
    await chat.text("the sparkling water is a need");
    await chat.tap(chat.last(), "Confirm");

    const items = await ledger.items();
    items.sort((a, b) => a.description.localeCompare(b.description));
    expect(items).toEqual([
      { description: "Bananas", bucket: "needs" },
      { description: "Rotisserie chicken", bucket: "wants" },
      { description: "Sparkling water", bucket: "needs" },
    ]);
    expect(await ledger.transactions()).toMatchObject([{ amount: "23.47", lines: 3 }]);
  });

  it("a correction that breaks the card is shown without buttons and the card keeps waiting", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    const patched = golden("edit-amount").recorded as { amount: string };
    gemini.patch = { ...patched, amount: "99.00" };
    await chat.text("it was 99");

    expect(chat.last().buttons).toEqual([]);
    expect(chat.last().text).toContain("✗ lines sum 14.50 != header 99.00");
    expect((await ledger.ingestions())[0].status).toBe("awaiting_edit");
  });

  it("a voice note sent while waiting for a correction is not read", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    const callsBefore = gemini.calls.length;
    await chat.voice();

    expect(gemini.calls).toHaveLength(callsBefore);
    expect(chat.last().text).toMatch(/^Still waiting for a correction/);
  });
});
