import { describe, expect, it } from "vitest";
import {
  addReply,
  cleanMerchantName,
  deleteReply,
  formatMerchants,
  parseCommand,
} from "../src/commands.js";

describe("merchant command replies", () => {
  it("lists the merchants with their count, says so when there are none, and cuts a list Telegram would refuse", () => {
    expect(formatMerchants(["A", "B"])).toBe("Merchants (2): A, B");
    expect(formatMerchants([])).toBe("No merchants.");
    const long = formatMerchants(Array.from({ length: 800 }, (_, i) => `Merchant number ${i}`));
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
    expect(addReply({ added: "Maple Kiosk" })).toBe(
      "Added merchant: Maple Kiosk. The next message will use it.",
    );
    expect(addReply({ exists: "Acme Mart" })).toBe("Already a merchant: Acme Mart.");
    expect(deleteReply({ deleted: "Maple Kiosk" }, "maple kiosk")).toBe("Deleted merchant: Maple Kiosk.");
    expect(deleteReply({ missing: true }, "Nowhere")).toBe(
      "No merchant named Nowhere. Send /merchants for the list.",
    );
    expect(deleteReply({ inUse: 1, name: "Acme Mart" }, "acme mart")).toBe(
      "Acme Mart is on 1 saved transaction, so it stays.",
    );
    expect(deleteReply({ inUse: 3, name: "Acme Mart" }, "acme mart")).toBe(
      "Acme Mart is on 3 saved transactions, so it stays.",
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
