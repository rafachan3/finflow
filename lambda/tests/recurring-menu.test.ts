import { describe, expect, it } from "vitest";
import { fitCadence } from "../src/recurring.js";
import type { Book, BookRow } from "../src/recurring-db.js";
import {
  addScreen,
  cadenceText,
  day,
  defaultName,
  flipVaries,
  listScreen,
  money,
  parseRecurringTap,
  pickScreen,
  range,
  recount,
} from "../src/recurring-menu.js";

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
    expect(first.keyboard.map((row) => row.length)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(first.keyboard.at(-1)).toEqual([
      { text: "➕ Add", callback_data: "r:a" },
      { text: "More ›", callback_data: "r:l:16" },
    ]);
    const second = listScreen(book(17), "2026-10-31", 16);
    expect(second.keyboard).toEqual([[{ text: "Bill 17", callback_data: "r:v:17" }], [{ text: "➕ Add", callback_data: "r:a" }]]);
  });
});

describe("adding a series", () => {
  const row = (over: Partial<BookRow>): BookRow => ({
    id: TX, date: "2026-10-15", type: "expense", amount: "64.99", description: "Internet bill October",
    merchantId: null, subcategoryId: null, incomeSourceId: null, fromAccountId: null, toAccountId: null,
    seriesId: null, flagged: false, merchant: null, source: null, ...over,
  });
  const empty: Book = { series: [], rows: [], pauses: new Map(), skips: new Map(), excluded: new Map(), dismissed: [] };

  it("names it after the merchant, the income source, or the description without dates, and numbers a taken name", () => {
    expect(defaultName(empty, row({}))).toBe("Internet bill");
    expect(defaultName(empty, row({ description: "gym 25 Aug 3" }))).toBe("Gym");
    expect(defaultName(empty, row({ description: "2026-10" }))).toBe("2026-10");
    expect(defaultName(empty, row({ merchant: "Acme Mart" }))).toBe("Acme Mart");
    expect(defaultName(empty, row({ type: "income", source: "Salary" }))).toBe("Salary");
    const taken = { ...empty, series: [{ name: "internet bill" }, { name: "Internet bill 2" }] } as unknown as Book;
    expect(defaultName(taken, row({}))).toBe("Internet bill 3");
  });

  it("flips amount varies in the keyboard and in every cadence button, and nothing else", () => {
    const keyboard = [
      [{ text: "✅ Monthly", callback_data: `r:ac:${TX}:m0` }],
      [{ text: "☐ Amount varies", callback_data: "r:av" }],
      [{ text: "‹ Back", callback_data: "r:a" }],
    ];
    const on = flipVaries(keyboard);
    expect(on).toEqual([
      [{ text: "✅ Monthly", callback_data: `r:ac:${TX}:m1` }],
      [{ text: "✅ Amount varies", callback_data: "r:av" }],
      [{ text: "‹ Back", callback_data: "r:a" }],
    ]);
    expect(flipVaries(on)).toEqual(keyboard);
  });

  it("an add screen for a payment already in a series, or gone, says so", () => {
    const linked = { ...empty, series: [{ id: 4, name: "Gym" }], rows: [row({ seriesId: 4 })] } as unknown as Book;
    expect(addScreen(linked, TX).text).toBe("That payment is already in Gym.");
    expect(addScreen(empty, TX).text).toBe("That payment no longer exists.");
    expect(pickScreen(empty, 0).text).toContain("No saved payment is outside a series.");
  });
});

describe("the review keyboards", () => {
  it("label Apply and Clear with what they will write, from the ticks", () => {
    const keyboard = [
      [{ text: "✅ a", callback_data: `r:bt:${TX}` }],
      [{ text: "☐ b", callback_data: "r:bt:22222222-2222-4222-8222-222222222222" }],
      [{ text: "", callback_data: "r:bk:3" }],
      [{ text: "", callback_data: "r:fk" }],
    ];
    expect(recount(keyboard).slice(2).map((row) => row[0].text)).toEqual(["✅ Link 1 · ignore 1", "Clear flag on ticked (1)"]);
  });
});

describe("recurring callback data", () => {
  it("reads every button's action, and nothing else", () => {
    expect(parseRecurringTap("r:l:16")).toEqual({ op: "list", offset: 16 });
    expect(parseRecurringTap("r:v:4294967295")).toEqual({ op: "view", sid: 4294967295 });
    expect(parseRecurringTap("r:p:3")).toEqual({ op: "pause", sid: 3 });
    expect(parseRecurringTap("r:pf:3:20261023")).toEqual({ op: "pauseFrom", sid: 3, from: "2026-10-23" });
    expect(parseRecurringTap("r:pd:3:20261023")).toEqual({ op: "pauseDate", sid: 3, from: "2026-10-23" });
    expect(parseRecurringTap("r:pu:3:20261023:0")).toEqual({ op: "pauseUntil", sid: 3, from: "2026-10-23", until: null });
    expect(parseRecurringTap("r:pu:3:20261023:20270131")).toEqual({
      op: "pauseUntil", sid: 3, from: "2026-10-23", until: "2027-01-31",
    });
    expect(parseRecurringTap("r:u:3:20261031")).toEqual({ op: "resume", sid: 3, on: "2026-10-31" });
    expect(parseRecurringTap("r:n:3")).toEqual({ op: "rename", sid: 3 });
    expect(parseRecurringTap("r:x:3")).toEqual({ op: "askDelete", sid: 3 });
    expect(parseRecurringTap("r:xy:3")).toEqual({ op: "delete", sid: 3 });
    expect(parseRecurringTap("r:a")).toEqual({ op: "pick", offset: 0 });
    expect(parseRecurringTap("r:ar:8")).toEqual({ op: "pick", offset: 8 });
    expect(parseRecurringTap(`r:at:${TX}`)).toEqual({ op: "addFrom", tx: TX });
    expect(parseRecurringTap("r:av")).toEqual({ op: "varies" });
    expect(parseRecurringTap(`r:ac:${TX}:s1`)).toEqual({ op: "create", tx: TX, cadence: "semimonthly", varies: true });
    expect(parseRecurringTap(`r:ac:${TX}:x1`)).toBeNull();
    expect(Buffer.byteLength(`r:ac:${TX}:y0`)).toBe(44);
    expect(parseRecurringTap("r:b")).toEqual({ op: "review", sid: null });
    expect(parseRecurringTap("r:b:7")).toEqual({ op: "review", sid: 7 });
    expect(parseRecurringTap(`r:bt:${TX}`)).toEqual({ op: "toggle", data: `r:bt:${TX}` });
    expect(parseRecurringTap(`r:ft:${TX}`)).toEqual({ op: "toggle", data: `r:ft:${TX}` });
    expect(parseRecurringTap("r:ba")).toEqual({ op: "all" });
    expect(parseRecurringTap("r:bk:7")).toEqual({ op: "apply", sid: 7 });
    expect(parseRecurringTap("r:bl")).toEqual({ op: "later" });
    expect(parseRecurringTap("r:f:8")).toEqual({ op: "flags", offset: 8 });
    expect(parseRecurringTap("r:fk")).toEqual({ op: "clear" });
    expect(parseRecurringTap("r:sg")).toEqual({ op: "suggestions" });
    expect(parseRecurringTap(`r:gd:${TX}`)).toEqual({ op: "dismiss", tx: TX });
    // The longest pause data, with a ten-digit series id, fits Telegram's 64 bytes.
    expect(Buffer.byteLength("r:pu:4294967295:20261023:20270131")).toBeLessThanOrEqual(64);
    for (const data of [undefined, "", "r:v:", "r:v:x", "r:l:12345", `c:${TX}`, "mt:1", "r:zz"]) {
      expect(parseRecurringTap(data), String(data)).toBeNull();
    }
  });
});
