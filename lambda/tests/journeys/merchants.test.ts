import { describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../../src/commands.js";
import { golden } from "../golden/golden.js";
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
function geminiReadsMerchant(merchant: string) {
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

    expect(await send("/addmerchant ACME  mart")).toEqual([
      "Unhid merchant: Acme Mart. The next message will use it.",
    ]);
    expect(await send("/merchants")).toEqual(["Merchants (2): Acme Mart, Example Online"]);

    await chat.text("14 lunch at Acme Mart on Oct 26");
    expect(gemini.merchants()).toEqual(["Acme Mart", "Example Online"]);
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ merchant: "Acme Mart" }, { merchant: "Acme Mart" }]);
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
