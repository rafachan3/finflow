import { describe, expect, it } from "vitest";
import { fitCadence } from "../src/recurring.js";
import type { Book } from "../src/recurring-db.js";
import { cadenceText, day, listScreen, money, parseRecurringTap, range } from "../src/recurring-menu.js";

const TX = "11111111-1111-4111-8111-111111111111";

describe("recurring menu formatting", () => {
  it("formats money from cents with thousands separators and no float", () => {
    expect([money(6499), money(200000), money(5), money(-1625), money(123456789)]).toEqual([
      "64.99",
      "2,000.00",
      "0.05",
      "−16.25",
      "1,234,567.89",
    ]);
  });

  it("formats days and windows, within a month and across one", () => {
    expect(day("2026-11-05")).toBe("Nov 5");
    expect(range("2026-11-13", "2026-11-17")).toBe("Nov 13–17");
    expect(range("2026-10-30", "2026-11-02")).toBe("Oct 30–Nov 2");
  });

  it.each([
    ["monthly", ["2026-08-15", "2026-09-15", "2026-10-15"], "monthly, around the 15th"],
    ["monthly", ["2026-08-31", "2026-09-30", "2026-10-31"], "monthly, around the last day"],
    ["monthly", ["2026-09-21", "2026-10-21"], "monthly, around the 21st"],
    ["semimonthly", ["2026-09-01", "2026-09-15", "2026-10-01", "2026-10-15"], "twice a month, the 1st and the 15th"],
    ["biweekly", ["2026-10-09", "2026-10-23"], "every 2 weeks, Fri"],
    ["weekly", ["2026-10-13", "2026-10-20"], "weekly, Tue"],
    ["quarterly", ["2026-04-12", "2026-07-12"], "quarterly, around the 12th"],
    ["yearly", ["2025-03-03", "2026-03-03"], "yearly, in Mar, around the 3rd"],
  ] as const)("describes a %s cadence as %j → %s", (cadence, dates, text) => {
    expect(cadenceText(cadence, fitCadence(cadence, [...dates]))).toBe(text);
  });

  it("names the bare cadence when nothing is linked", () => {
    expect(cadenceText("semimonthly", null)).toBe("twice a month");
  });
});

describe("the /recurring list", () => {
  const series = (id: number) => ({
    id, name: `Bill ${String(id).padStart(2, "0")}`, kind: "expense" as const, cadence: "monthly" as const,
    amountVaries: id === 1, merchantId: null, subcategoryId: null, incomeSourceId: null, fromAccountId: null,
    toAccountId: null, keywords: [], subcategory: null, source: null, fromAccount: null, toAccount: null,
  });
  const book = (n: number): Book => ({
    series: Array.from({ length: n }, (_, i) => series(i + 1)),
    rows: [], pauses: new Map(), skips: new Map(), excluded: new Map(), dismissed: [],
  });

  it("shows 16 series a page, two buttons a row, with More › to the rest", () => {
    const first = listScreen(book(17), "2026-10-31");
    expect(first.text.split("\n").filter((l) => l.startsWith("•"))).toHaveLength(16);
    expect(first.text).toContain("• Bill 01 — monthly · varies · no payments linked");
    expect(first.keyboard.map((row) => row.length)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 1]);
    expect(first.keyboard.at(-1)).toEqual([{ text: "More ›", callback_data: "r:l:16" }]);
    const second = listScreen(book(17), "2026-10-31", 16);
    expect(second.keyboard).toEqual([[{ text: "Bill 17", callback_data: "r:v:17" }]]);
  });
});

describe("recurring callback data", () => {
  it("reads every button's action, and nothing else", () => {
    expect(parseRecurringTap("r:l:16")).toEqual({ op: "list", offset: 16 });
    expect(parseRecurringTap("r:v:4294967295")).toEqual({ op: "view", sid: 4294967295 });
    for (const data of [undefined, "", "r:v:", "r:v:x", "r:l:12345", `c:${TX}`, "mt:1", "r:zz"]) {
      expect(parseRecurringTap(data), String(data)).toBeNull();
    }
  });
});
