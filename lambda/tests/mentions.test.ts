import { describe, expect, it } from "vitest";
import {
  linkedSummary,
  mentionLabel,
  mentionPattern,
  mentionsMessage,
  parseMentionTap,
  selectAll,
  ticked,
  toggle,
  withoutMore,
  type Mention,
} from "../src/mentions.js";

const TX1 = "11111111-1111-4111-8111-111111111111";
const TX2 = "22222222-2222-4222-8222-222222222222";

function mention(over: Partial<Mention> = {}): Mention {
  return { id: TX1, date: "2026-09-15", amount: "12.50", description: "Burger", said: null, ...over };
}

describe("mention labels", () => {
  it("shows the date, amount and the words around the match, from the message before the description", () => {
    expect(mentionLabel(mention({ said: "4 burger from maple’s" }), "Maple's")).toBe(
      '☐ Sep 15 · 12.50 · "4 burger from maple’s"',
    );
    expect(mentionLabel(mention({ description: "Coffee at Maple Kiosk" }), "maple kiosk")).toBe(
      '☐ Sep 15 · 12.50 · "Coffee at Maple Kiosk"',
    );
  });

  it("cuts long text to a window around the match, marking what it cut", () => {
    const said = "a very long note about lunch with friends at Maple   Kiosk near the old station downtown";
    expect(mentionLabel(mention({ said }), "Maple Kiosk")).toBe(
      '☐ Sep 15 · 12.50 · "…at Maple Kiosk near the…"',
    );
    const start = "Maple Kiosk and a long list of other things bought that day";
    expect(mentionLabel(mention({ said: start }), "Maple Kiosk")).toBe(
      '☐ Sep 15 · 12.50 · "Maple Kiosk and a long list of…"',
    );
  });

  it("falls back to the description when the match cannot be placed", () => {
    expect(mentionLabel(mention({ description: "A description far longer than thirty characters" }), "Nowhere")).toBe(
      '☐ Sep 15 · 12.50 · "A description far longer than…"',
    );
  });
});

describe("mention pattern", () => {
  it("is the merchant key between non-word characters, with regex characters escaped", () => {
    expect(mentionPattern("  Maple   Kiosk ")).toBe("(^|[^[:alnum:]_])maple kiosk($|[^[:alnum:]_])");
    expect(mentionPattern("A+B (C.)")).toBe("(^|[^[:alnum:]_])a\\+b \\(c\\.\\)($|[^[:alnum:]_])");
  });
});

describe("the review keyboard", () => {
  const page = { total: 3, rows: [mention(), mention({ id: TX2, description: "Fries" })] };

  it("puts one toggle per mention, then Link selected, Select all and Skip, and More only when more remain", () => {
    const first = mentionsMessage(7, "Burger Hut", page, false);
    expect(first.text).toBe("Check 3 that mention Burger Hut. Tap to pick, then Link:");
    expect(first.keyboard.map((row) => row.map((b) => b.callback_data))).toEqual([
      [`mt:${TX1}`],
      [`mt:${TX2}`],
      ["ml:7", "ma", "ms"],
      [`mp:7:${TX2}`],
    ]);
    const last = mentionsMessage(7, "Burger Hut", { total: 2, rows: page.rows }, true);
    expect(last.text).toBe("Check 2 more that mention Burger Hut. Tap to pick, then Link:");
    expect(last.keyboard).toHaveLength(3);
    for (const button of first.keyboard.flat()) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  });

  it("flips one toggle, ticks all, reads the ticked ids, and drops More", () => {
    const { keyboard } = mentionsMessage(7, "Burger Hut", page, false);
    const one = toggle(keyboard, `mt:${TX2}`);
    expect(one[1][0].text.startsWith("✅ ")).toBe(true);
    expect(one[0][0].text.startsWith("☐ ")).toBe(true);
    expect(ticked(one)).toEqual({ ids: [TX2], shown: 2 });
    expect(ticked(toggle(one, `mt:${TX2}`))).toEqual({ ids: [], shown: 2 });
    expect(ticked(selectAll(keyboard))).toEqual({ ids: [TX1, TX2], shown: 2 });
    expect(withoutMore(keyboard).flat().some((b) => b.callback_data.startsWith("mp:"))).toBe(false);
  });

  it("reads each tap's action and ignores anything else", () => {
    expect(parseMentionTap(`mt:${TX1}`)).toEqual({ kind: "toggle" });
    expect(parseMentionTap("ma")).toEqual({ kind: "all" });
    expect(parseMentionTap("ms")).toEqual({ kind: "skip" });
    expect(parseMentionTap("ml:7")).toEqual({ kind: "link", merchantId: 7 });
    expect(parseMentionTap(`mp:7:${TX1}`)).toEqual({ kind: "more", merchantId: 7, after: TX1 });
    for (const data of [undefined, "mt:nope", "ml:x", `c:${TX1}`, "mp:7", "ma:1"]) {
      expect(parseMentionTap(data), String(data)).toBeNull();
    }
  });

  it("summarises a link, naming picks that already had a merchant", () => {
    expect(linkedSummary({ name: "Burger Hut", linked: 2, picked: 2, shown: 3 })).toBe("Linked 2 of 3 to Burger Hut.");
    expect(linkedSummary({ name: "Burger Hut", linked: 1, picked: 3, shown: 3 })).toBe(
      "Linked 1 of 3 to Burger Hut. 2 already had a merchant.",
    );
  });
});
