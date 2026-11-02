import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../src/commands.js";
import { golden } from "../golden/golden.js";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, ledger, STRANGER, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

/** The replies one message produced. */
async function send(text: string) {
  const before = chat.replies().length;
  await chat.text(text);
  return chat.replies().slice(before).map((r) => r.text);
}

/** Gemini reads a purchase at `merchant`, whatever the lookup holds. */
function geminiReadsMerchant(merchant: string | null) {
  const recorded = golden("text-with-note").recorded as { events: object[] };
  gemini.extract = { events: [{ ...recorded.events[0], merchant }] };
}

describe("merchant commands", () => {
  it("a merchant added from Telegram is listed in the next extraction and linked on Confirm", async () => {
    expect(await send("/addmerchant  Maple   Kiosk")).toEqual([
      "Added merchant: Maple Kiosk. The next message will use it.",
    ]);
    expect(gemini.calls).toEqual([]);

    geminiReadsMerchant("Maple Kiosk");
    await chat.text("14 lunch at Maple Kiosk on Oct 25");
    expect(gemini.merchants()).toEqual(["Acme Mart", "Example Online", "Maple Kiosk"]);

    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ merchant: "Maple Kiosk" }]);
  });

  it("a deleted merchant is not listed in the next extraction and is not linked", async () => {
    await chat.text("/addmerchant Maple Kiosk");
    expect(await send("/delmerchant maple KIOSK")).toEqual(["Deleted merchant: Maple Kiosk."]);

    geminiReadsMerchant("Maple Kiosk");
    await chat.text("14 lunch at Maple Kiosk on Oct 25");
    expect(gemini.merchants()).toEqual(["Acme Mart", "Example Online"]);

    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ merchant: null }]);
  });

  it("a merchant on saved transactions is hidden: it stays on them, the next extraction leaves it out, and Confirm does not link it", async () => {
    geminiReadsMerchant("Acme Mart");
    await chat.text("14 lunch at Acme Mart on Oct 25");
    await chat.tap(chat.last(), "Confirm");

    expect(await send("/delmerchant acme mart")).toEqual([
      "Hid Acme Mart: it stays on 1 saved transaction but won't be suggested.",
    ]);
    expect(await send("/merchants")).toEqual(["Merchants (1, 1 hidden): Example Online"]);

    await chat.text("14 lunch at Acme Mart on Oct 26");
    expect(gemini.merchants()).toEqual(["Example Online"]);
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ merchant: "Acme Mart" }, { merchant: null }]);
  });

  it("/addmerchant on a hidden merchant brings it back to the next extraction", async () => {
    geminiReadsMerchant("Acme Mart");
    await chat.text("14 lunch at Acme Mart on Oct 25");
    await chat.tap(chat.last(), "Confirm");
    await chat.text("/delmerchant Acme Mart");
    await chat.text("14 lunch at Acme Mart on Oct 26");
    await chat.tap(chat.last(), "Confirm");

    expect(await send("/addmerchant ACME  mart")).toEqual([
      "Unhid merchant: Acme Mart. Linked 1 past transaction that names it exactly. The next message will use it.",
    ]);
    expect(await send("/merchants")).toEqual(["Merchants (2): Acme Mart, Example Online"]);

    await chat.text("14 lunch at Acme Mart on Oct 27");
    expect(gemini.merchants()).toEqual(["Acme Mart", "Example Online"]);
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([
      { merchant: "Acme Mart" },
      { merchant: "Acme Mart" },
      { merchant: "Acme Mart" },
    ]);
  });

  it("/addmerchant links past saved transactions that named it and leaves already-linked ones alone", async () => {
    geminiReadsMerchant("maple kiosk");
    await chat.text("14 lunch at Maple Kiosk on Oct 25");
    await chat.tap(chat.last(), "Confirm");
    geminiReadsMerchant("Acme Mart");
    await chat.text("14 lunch at Acme Mart on Oct 26");
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ merchant: null }, { merchant: "Acme Mart" }]);

    expect(await send("/addmerchant Maple Kiosk")).toEqual([
      "Added merchant: Maple Kiosk. Linked 1 past transaction that names it exactly. The next message will use it.",
    ]);
    expect(await ledger.transactions()).toMatchObject([
      { merchant: "Maple Kiosk" },
      { merchant: "Acme Mart" },
    ]);
    expect(gemini.calls).toHaveLength(2);
  });

  it("/addmerchant links a receipt photo whose re-read media names it, though its extraction named no merchant", async () => {
    geminiReadsMerchant(null);
    await chat.photo();
    await chat.tap(chat.last(), "Confirm");
    // What the one-off media backfill stores after re-reading the archived photo.
    await sql("update ingestions set media_merchant = 'MAPLE KIOSK'");

    expect(await send("/addmerchant Maple Kiosk")).toEqual([
      "Added merchant: Maple Kiosk. Linked 1 past transaction that names it exactly. The next message will use it.",
    ]);
    expect(await ledger.transactions()).toMatchObject([{ merchant: "Maple Kiosk" }]);
  });

  it("/addmerchant links an imported row named with a curly apostrophe, and leaves a longer description alone", async () => {
    await ledger.importRow("Joe’s Diner");
    await ledger.importRow("Joe’s Diner lunch");
    await ledger.importRow("Bike Share Monthly Pass");

    expect(await send("/addmerchant Joe's Diner")).toEqual([
      "Added merchant: Joe's Diner. Linked 1 past transaction that names it exactly. The next message will use it.",
      "Check 1 that mentions Joe's Diner. Tap to pick, then Link:",
    ]);
    expect(await ledger.transactions()).toMatchObject([
      { description: "Joe’s Diner", merchant: "Joe's Diner" },
      { description: "Joe’s Diner lunch", merchant: null },
      { description: "Bike Share Monthly Pass", merchant: null },
    ]);
  });

  it("/addmerchant on an existing merchant links what is still unlinked, and says so only when it did", async () => {
    await ledger.importRow("Acme Mart");
    await ledger.importRow("ACME MART");

    expect(await send("/addmerchant Acme Mart")).toEqual([
      "Already a merchant: Acme Mart. Linked 2 past transactions that name it exactly.",
    ]);
    expect(await ledger.transactions()).toMatchObject([{ merchant: "Acme Mart" }, { merchant: "Acme Mart" }]);
    expect(await send("/addmerchant Acme Mart")).toEqual(["Already a merchant: Acme Mart."]);
  });

  it("/merchants lists them sorted, and a command with no usable name gets a hint, not a write", async () => {
    expect(await send("/merchants")).toEqual(["Merchants (2): Acme Mart, Example Online"]);
    expect(await send("/addmerchant")).toEqual(["Send /addmerchant Name"]);
    expect(await send("/addmerchant@any_bot Shop, Inc")).toEqual([
      "A merchant name can't contain a comma.",
    ]);
    expect(await send("/addmerchant acme mart")).toEqual(["Already a merchant: Acme Mart."]);
    expect(await send("/delmerchant")).toEqual(["Send /delmerchant Name"]);
    expect(await send("/delmerchant Nowhere")).toEqual([
      "No merchant named Nowhere. Send /merchants for the list.",
    ]);
    expect(await send("/merchants")).toEqual(["Merchants (2): Acme Mart, Example Online"]);
    expect(gemini.calls).toEqual([]);
  });

  it("a merchant command while a card waits for a correction is not sent to Gemini", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25");
    await chat.tap(chat.last(), "Edit");

    expect(await send("/addmerchant Maple Kiosk")).toEqual([
      "Added merchant: Maple Kiosk. The next message will use it.",
    ]);
    expect(gemini.calls).toHaveLength(1);
    expect((await ledger.ingestions()).map((r) => r.status)).toEqual(["awaiting_edit"]);
  });

  it("a merchant command from a chat that is not on the allowlist does nothing", async () => {
    await chat.text("/addmerchant Maple Kiosk", STRANGER);
    expect(chat.replies()).toEqual([]);
    expect(await send("/merchants")).toEqual(["Merchants (2): Acme Mart, Example Online"]);
  });

  it("every command in the menu is answered without asking Gemini", async () => {
    for (const name of Object.keys(COMMANDS)) {
      expect(await send(`/${name}`), name).toHaveLength(1);
    }
    expect(gemini.calls).toEqual([]);
  });
});
