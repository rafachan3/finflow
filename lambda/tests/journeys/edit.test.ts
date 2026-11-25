import { describe, expect, it, vi } from "vitest";
import { clock, GEMINI_FALLBACK_MODEL, GEMINI_MODEL, REASK_BUDGET_MS } from "../../src/gemini.js";
import { golden } from "../golden/golden.js";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, labels, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
});

useJourneys();

const ASK_EDIT = "Send the correction — amount, category, a line, whatever is wrong.";

async function lunchCard() {
  gemini.extract = golden("text-with-note").recorded;
  await chat.text("14 lunch at Sandwich Shop on Oct 25, didnt pak it, was to tierd, my lunch i mean");
  return chat.last();
}

describe("correcting a card with Edit", () => {
  it("Edit asks for the correction, and the corrected card saves the new amount", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    expect(chat.acks()).toEqual(["Send the correction."]);
    expect(chat.last().text).toBe(ASK_EDIT);
    expect(labels(chat.last())).toEqual(["Keep as is", "Discard"]);

    gemini.patch = golden("edit-amount").recorded;
    await chat.text("it was 14.50");
    const fixed = chat.last();
    expect(fixed.text.split("\n")[0]).toBe("Expense · 2026-10-25 · CAD 14.50");
    expect(fixed.text).toContain("Note: I was too tired and didn't pack my lunch.");

    await chat.tap(fixed, "Confirm");
    expect(await ledger.transactions()).toMatchObject([
      { amount: "14.50", date: "2026-10-25", notes: "I was too tired and didn't pack my lunch." },
    ]);
  });

  it("an Edit can say the order went through an app, and another that it did not, and Confirm saves no channel", async () => {
    const card = await lunchCard();
    const lunch = (golden("text-with-note").recorded as { events: object[] }).events[0];
    await chat.tap(card, "Edit");
    gemini.patch = { ...lunch, channel: "DoorDash" };
    await chat.text("it was on doordash");
    expect(chat.last().text).toContain("Venue: Fast Food\nChannel: DoorDash\n");
    expect(JSON.parse(gemini.lastUserText[0]).channel).toBeNull();

    await chat.tap(chat.last(), "Edit");
    gemini.patch = { ...lunch, channel: null };
    await chat.text("no, I picked it up at the counter");
    expect(JSON.parse(gemini.lastUserText[0]).channel).toBe("DoorDash");
    expect(chat.last().text).not.toContain("Channel:");

    await chat.tap(chat.last(), "Confirm");
    expect(await sql("select channel_id from transactions")).toEqual([{ channel_id: null }]);
  });

  it("an Edit that turns a deposit into a withdrawal saves the account it leaves", async () => {
    const [deposit] = (golden("transfer-withdrawal").recorded as { events: object[] }).events;
    gemini.extract = { events: [deposit] };
    await chat.text("moved 50 to my emergency fund on Oct 26");
    await chat.tap(chat.last(), "Edit");
    gemini.patch = { ...deposit, from_account: "Emergency fund", to_account: null };
    await chat.text("no, I took it out of the emergency fund");

    const fixed = chat.last();
    expect(fixed.text).toContain("From account: Emergency fund\nTo account: chequing");
    await chat.tap(fixed, "Confirm");
    expect(await ledger.transactions()).toMatchObject([
      { type: "transfer", from_account: "Emergency fund", account: null },
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

  it("a correction that breaks the card keeps waiting with Keep as is and Discard", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    const patched = golden("edit-amount").recorded as { amount: string };
    gemini.patch = { ...patched, amount: "99.00" };
    await chat.text("it was 99");

    expect(labels(chat.last())).toEqual(["Keep as is", "Discard"]);
    expect(chat.last().text).toContain("✗ lines sum 14.50 != header 99.00");
    expect((await ledger.ingestions())[0].status).toBe("awaiting_edit");
  });

  it("a correction whose answer lost every line fails visibly and keeps the stored card, not a made-up line", async () => {
    const card = await lunchCard();
    const line = card.text.split("\n").find((l) => l.startsWith("• "))!;
    await chat.tap(card, "Edit");
    const patched = golden("edit-amount").recorded as { items: unknown[] };
    gemini.patch = { ...patched, items: [] };
    await chat.text("it was 14.50");

    expect(labels(chat.last())).toEqual(["Keep as is", "Discard"]);
    expect(chat.last().text).toContain("✗ expense needs at least one line");
    expect(chat.last().text).not.toContain("Other shopping");
    expect((await ledger.ingestions())[0].status).toBe("awaiting_edit");

    await chat.tap(chat.last(), "Keep as is");
    expect(chat.last().text).toContain(line);
    expect(chat.last().text).not.toContain("Other shopping");
  });

  it("Keep as is on an edit wait resends the Confirm card without Gemini", async () => {
    const card = await lunchCard();
    const header = card.text.split("\n")[0];
    await chat.tap(card, "Edit");
    const callsBefore = gemini.calls.length;
    await chat.tap(chat.last(), "Keep as is");

    expect(chat.acks()).toEqual(["Send the correction.", "Kept as is."]);
    expect(gemini.calls).toHaveLength(callsBefore);
    expect((await ledger.ingestions())[0].status).toBe("pending");
    expect(chat.last().text.split("\n")[0]).toBe(header);
    expect(labels(chat.last())).toEqual(["Confirm", "Discard", "Fix date", "Edit"]);
  });

  it("a voice note sent while waiting for a correction is the correction", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    gemini.transcript = "it was fourteen fifty";
    gemini.patch = golden("edit-amount").recorded;
    const callsBefore = gemini.calls.length;
    await chat.voice();

    expect(gemini.calls.slice(callsBefore).map((c) => c.kind)).toEqual(["transcribe", "patch"]);
    expect(gemini.lastUserText[1]).toBe("it was fourteen fifty");
    const fixed = chat.last();
    expect(fixed.text.split("\n")[0]).toBe("Expense · 2026-10-25 · CAD 14.50");
    expect(await ledger.ingestions()).toMatchObject([{ source: "text", status: "pending" }]);

    await chat.tap(fixed, "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "14.50" }]);
  });

  it("a caption on a spoken correction is part of the correction", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    gemini.transcript = "and it was fourteen fifty";
    gemini.patch = golden("edit-amount").recorded;
    await chat.voice("the sandwich");

    expect(gemini.lastUserText[1]).toBe("the sandwich\nand it was fourteen fifty");
  });

  it("a spoken correction starts the patch on the model that transcribed it", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    gemini.transcript = "it was fourteen fifty";
    gemini.patch = golden("edit-amount").recorded;
    gemini.overloaded = new Set([GEMINI_MODEL]);
    const callsBefore = gemini.calls.length;
    await chat.voice();

    expect(gemini.calls.slice(callsBefore)).toEqual([
      { model: GEMINI_MODEL, kind: "transcribe" },
      { model: GEMINI_FALLBACK_MODEL, kind: "transcribe" },
      { model: GEMINI_FALLBACK_MODEL, kind: "patch" },
    ]);
  });

  it("a voice note that took too long to read is not patched, and the card keeps waiting", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    gemini.transcript = "it was fourteen fifty";
    gemini.patch = golden("edit-amount").recorded;
    const callsBefore = gemini.calls.length;
    const realNow = clock.now;
    let t = 0;
    clock.now = () => (t += REASK_BUDGET_MS + 1);
    try {
      await chat.voice();
    } finally {
      clock.now = realNow;
    }

    expect(gemini.calls.slice(callsBefore).map((c) => c.kind)).toEqual(["transcribe"]);
    expect(chat.last().text).toMatch(/^That voice note took too long/);
    expect(labels(chat.last())).toEqual(["Keep as is", "Discard"]);
    expect((await ledger.ingestions())[0].status).toBe("awaiting_edit");
  });

  it("a voice note with nothing in it keeps the card waiting", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    gemini.transcript = "  ";
    const callsBefore = gemini.calls.length;
    await chat.voice();

    expect(gemini.calls.slice(callsBefore).map((c) => c.kind)).toEqual(["transcribe"]);
    expect(chat.last().text).toMatch(/^Still waiting for a correction/);
    expect(labels(chat.last())).toEqual(["Keep as is", "Discard"]);
    expect((await ledger.ingestions())[0].status).toBe("awaiting_edit");
  });

  it("a voice note that cannot be read keeps the card waiting for the next try", async () => {
    const card = await lunchCard();
    await chat.tap(card, "Edit");
    await chat.voice();

    expect(chat.last().text).toMatch(/^Couldn't read that voice note/);
    expect(labels(chat.last())).toEqual(["Keep as is", "Discard"]);
    expect((await ledger.ingestions())[0].status).toBe("awaiting_edit");

    gemini.patch = golden("edit-amount").recorded;
    await chat.text("it was 14.50");
    expect(chat.last().text.split("\n")[0]).toBe("Expense · 2026-10-25 · CAD 14.50");
  });
});
