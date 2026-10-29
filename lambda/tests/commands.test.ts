import { describe, expect, it } from "vitest";
import {
  addReply,
  cleanMerchantName,
  deleteReply,
  formatMerchants,
  merchantKey,
  parseCommand,
} from "../src/commands.js";

describe("merchant key", () => {
  it("makes case, spacing and apostrophe or quote variants one key", () => {
    const key = "joe's diner";
    for (const raw of ["Joe's Diner", "Joe’s Diner", "JOE‘S  DINER", " joe`s diner\n", "Joe´s Diner"]) {
      expect(merchantKey(raw)).toBe(key);
    }
    expect(merchantKey("Joes Diner")).not.toBe(key);
  });
});

describe("merchant command replies", () => {
  it("lists the visible merchants with their count and the hidden count, says so when there are none, and cuts a list Telegram would refuse", () => {
    expect(formatMerchants({ names: ["A", "B"], hidden: 0 })).toBe("Merchants (2): A, B");
    expect(formatMerchants({ names: ["A"], hidden: 2 })).toBe("Merchants (1, 2 hidden): A");
    expect(formatMerchants({ names: [], hidden: 0 })).toBe("No merchants.");
    expect(formatMerchants({ names: [], hidden: 1 })).toBe("No merchants (1 hidden).");
    const long = formatMerchants({
      names: Array.from({ length: 800 }, (_, i) => `Merchant number ${i}`),
      hidden: 0,
    });
    expect(long).toHaveLength(4096);
    expect(long.endsWith("…")).toBe(true);
  });

  it("collapses spaces in a merchant name and refuses an empty, over-long or comma name with a reason", () => {
    expect(cleanMerchantName("  Maple \n  Kiosk ")).toEqual({ name: "Maple Kiosk" });
    expect(cleanMerchantName("")).toEqual({ error: "Send /addmerchant Name" });
    expect(cleanMerchantName("x".repeat(101))).toEqual({
      error: "A merchant name is at most 100 characters.",
    });
    expect(cleanMerchantName("x".repeat(100))).toEqual({ name: "x".repeat(100) });
    expect(cleanMerchantName("Shop, Inc")).toEqual({
      error: "A merchant name can't contain a comma.",
    });
  });

  it("answers an add and a delete in each outcome, with 'transaction' singular for one", () => {
    expect(addReply({ added: "Maple Kiosk", unhid: false, linked: 0 })).toBe(
      "Added merchant: Maple Kiosk. The next message will use it.",
    );
    expect(addReply({ added: "Maple Kiosk", unhid: false, linked: 1 })).toBe(
      "Added merchant: Maple Kiosk. Linked 1 past transaction that names it exactly. The next message will use it.",
    );
    expect(addReply({ added: "Acme Mart", unhid: true, linked: 7 })).toBe(
      "Unhid merchant: Acme Mart. Linked 7 past transactions that name it exactly. The next message will use it.",
    );
    expect(addReply({ exists: "Acme Mart", linked: 0 })).toBe("Already a merchant: Acme Mart.");
    expect(addReply({ exists: "Acme Mart", linked: 1 })).toBe(
      "Already a merchant: Acme Mart. Linked 1 past transaction that names it exactly.",
    );
    expect(addReply({ exists: "Acme Mart", linked: 4 })).toBe(
      "Already a merchant: Acme Mart. Linked 4 past transactions that name it exactly.",
    );
    expect(deleteReply({ deleted: "Maple Kiosk" }, "maple kiosk")).toBe("Deleted merchant: Maple Kiosk.");
    expect(deleteReply({ missing: true }, "Nowhere")).toBe(
      "No merchant named Nowhere. Send /merchants for the list.",
    );
    expect(deleteReply({ hidden: "Acme Mart", uses: 1 }, "acme mart")).toBe(
      "Hid Acme Mart: it stays on 1 saved transaction but won't be suggested.",
    );
    expect(deleteReply({ hidden: "Acme Mart", uses: 12 }, "acme mart")).toBe(
      "Hid Acme Mart: it stays on 12 saved transactions but won't be suggested.",
    );
  });
});

describe("parseCommand", () => {
  it("reads a known slash command with or without @botname, in any case, and its argument", () => {
    expect(parseCommand("/pending")).toEqual({ name: "pending", args: "" });
    expect(parseCommand("  /Pending@any_bot ")).toEqual({ name: "pending", args: "" });
    expect(parseCommand("/pending@any_bot now")).toEqual({ name: "pending", args: "now" });
  });

  it("returns nothing for plain text, an unknown command, or a longer word", () => {
    expect(parseCommand("12.50 lunch")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("/pending5")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});
