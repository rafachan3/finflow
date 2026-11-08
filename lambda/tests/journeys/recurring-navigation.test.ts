import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, invokeNudge, labels, ledger, useJourneys, type Reply } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return {
    getConfig: async () => config,
    getDbUrl: async () => config.databaseUrl,
    getNudgeConfig: async () => ({
      botToken: config.botToken,
      allowedChatIds: config.allowedChatIds,
      databaseUrl: config.databaseUrl,
    }),
  };
});

useJourneys();

// The schedule fires at 09:00 Toronto; Oct 31 2026 is still daylight time (UTC-4).
const NOW = new Date("2026-10-31T13:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

const bill = (date: string, amount = "64.99", description = "Internet bill") => ({
  date,
  amount,
  description,
  subcategory: "Internet and phone",
});

/** An internet bill tracked from August, with three earlier bills not linked yet: the digest has a Review. */
async function internet(): Promise<number> {
  await ledger.add(bill("2026-05-15"), bill("2026-06-15"), bill("2026-07-14"));
  return ledger.track("Internet bill", "monthly", await ledger.add(bill("2026-08-17"), bill("2026-09-15"), bill("2026-10-15")));
}

async function digest(): Promise<Reply> {
  await invokeNudge(NOW.toISOString());
  return chat.last();
}

async function open(): Promise<Reply> {
  await chat.text("/recurring");
  return chat.last();
}

const links = () => sql("SELECT count(*)::int AS n FROM transactions WHERE recurring_series_id IS NOT NULL");

describe("closing the /recurring menu", () => {
  it("✕ Close deletes the menu message", async () => {
    await internet();
    const menu = await open();
    expect(labels(menu).at(-1)).toBe("✕ Close");
    await chat.tap(menu, "✕ Close");
    expect(chat.exists(menu)).toBe(false);
    expect(chat.acks()).toEqual([""]);
  });

  it("Close on a message Telegram will not delete leaves it as Closed. with no buttons", async () => {
    await internet();
    const menu = await open();
    await chat.tap(menu, "🧹 Review (3)");
    chat.refuseNextDeletes(1);
    await chat.press(menu, "r:z");
    expect(chat.current(menu)).toEqual({ text: "Closed.", buttons: [], messageId: menu.messageId });
  });

  it("a series' detail and the Add list close too", async () => {
    await internet();
    const menu = await open();
    await chat.tap(menu, "Internet bill");
    expect(labels(chat.current(menu)).slice(-2)).toEqual(["‹ All recurring", "✕ Close"]);
    await chat.tap(menu, "‹ All recurring");
    await chat.tap(menu, "➕ Add");
    expect(labels(chat.current(menu)).slice(-2)).toEqual(["‹ All recurring", "✕ Close"]);
    await chat.tap(menu, "✕ Close");
    expect(chat.exists(menu)).toBe(false);
  });
});

describe("menu screens reached from the digest", () => {
  it("browsing Review from the digest, then ‹ Back to digest, puts the digest back", async () => {
    await internet();
    const sent = await digest();
    const before = chat.current(sent);
    expect(labels(sent)).toContain("🧹 Review (3)");

    await chat.tap(sent, "🧹 Review (3)");
    expect(chat.current(sent).text.split("\n")[0]).toBe("🧹 Internet bill: past payments that look like it");
    expect(labels(chat.current(sent))[0]).toBe("‹ Back to digest");
    await chat.tap(sent, "✅ May 15 · 64.99 · Internet bill");

    await chat.tap(sent, "‹ Back to digest");
    expect(chat.current(sent)).toEqual(before);
    // Browsing wrote nothing.
    expect(await links()).toEqual([{ n: 3 }]);
  });

  it("every menu screen drawn on the digest leads back to it and has no Close", async () => {
    await internet();
    const sent = await digest();
    await chat.tap(sent, "↻ All recurring");
    const list = labels(chat.current(sent));
    expect(list[0]).toBe("‹ Back to digest");
    expect(list).not.toContain("✕ Close");

    await chat.tap(sent, "Internet bill");
    expect(labels(chat.current(sent))[0]).toBe("‹ Back to digest");
    expect(labels(chat.current(sent))).not.toContain("✕ Close");

    await chat.tap(sent, "🧹 Review matches (3)");
    await chat.tap(sent, "Later");
    // Later empties a review's buttons; on a digest the way back stays.
    expect(labels(chat.current(sent))).toEqual(["‹ Back to digest"]);
    await chat.tap(sent, "‹ Back to digest");
    expect(chat.current(sent).text.split("\n")[0]).toBe("↻ Recurring · Sat Oct 31");
  });

  it("a Close pressed on a digest never deletes it", async () => {
    await internet();
    const sent = await digest();
    const before = chat.current(sent);
    await chat.press(sent, "r:z");
    expect(chat.exists(sent)).toBe(true);
    expect(chat.current(sent)).toEqual(before);
    expect(chat.acks().at(-1)).toBe("The digest stays. Tap ‹ Back to digest.");
  });
});

describe("leaving the add screen", () => {
  it("‹ Back on the add screen returns to the pick list it came from, and Cancel to the list", async () => {
    await ledger.add(bill("2026-09-01", "45.00", "Phone bill"));
    const menu = await open();
    await chat.tap(menu, "➕ Add");
    await chat.tap(menu, "Sep 1 · 45.00 · Phone bill");
    expect(labels(chat.current(menu)).slice(-2)).toEqual(["‹ Back", "Cancel"]);
    await chat.tap(menu, "‹ Back");
    expect(chat.current(menu).text.split("\n")[0]).toBe("➕ Add a recurring item");

    await chat.tap(menu, "Sep 1 · 45.00 · Phone bill");
    await chat.tap(menu, "Cancel");
    expect(chat.current(menu).text.split("\n")[0]).toBe("↻ Recurring · 0 tracked");
    expect(await sql("SELECT count(*)::int AS n FROM recurring_series")).toEqual([{ n: 0 }]);
  });

  it("from a Saved reply, ‹ Back puts the reply back with its buttons and Cancel puts back a plain Saved", async () => {
    gemini.extract = {
      events: [
        {
          type: "expense", amount: "64.99", currency: "CAD", date: "2026-10-15", description: "Internet bill",
          merchant: null, venue: null, tags: [], funded_by: null, is_recurring: true, income_source: null,
          to_account: null, notes: null, confidence: 0.9,
          items: [{ description: "Internet bill", amount: "64.99", category: "Bills", subcategory: "Internet and phone", item_type: null }],
        },
      ],
    };
    await chat.text("internet bill 64.99 on Oct 15");
    await chat.tap(chat.last(), "Confirm");
    const saved = chat.last();
    expect(labels(saved)).toEqual(["↻ New recurring item"]);

    await chat.tap(saved, "↻ New recurring item");
    expect(chat.current(saved).text.split("\n")[0]).toBe("➕ New recurring item");
    await chat.tap(saved, "‹ Back");
    expect(chat.current(saved)).toEqual({ text: "Saved.", buttons: saved.buttons, messageId: saved.messageId });

    await chat.tap(saved, "↻ New recurring item");
    await chat.tap(saved, "Cancel");
    expect(chat.current(saved)).toEqual({ text: "Saved.", buttons: [], messageId: saved.messageId });
    expect(await sql("SELECT count(*)::int AS n FROM recurring_series")).toEqual([{ n: 0 }]);
  });
});
