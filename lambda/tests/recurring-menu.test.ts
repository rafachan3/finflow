import { describe, expect, it } from "vitest";
import { fitCadence } from "../src/recurring.js";
import type { Book, BookRow, BookSeries } from "../src/recurring-db.js";
import {
  addScreen,
  joinable,
  answerPrompt,
  dayIn,
  hasMoney,
  looksLikeExpense,
  pauseEnd,
  PROMPT_TTL_SECONDS,
  type PromptReply,
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
    expect(first.keyboard.map((row) => row.length)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 1, 2]);
    expect(first.keyboard.slice(-2)).toEqual([
      [{ text: "More ›", callback_data: "r:l:16" }],
      [{ text: "➕ Add", callback_data: "r:a" }, { text: "✕ Close", callback_data: "r:z" }],
    ]);
    const second = listScreen(book(17), "2026-10-31", 16);
    expect(second.keyboard).toEqual([
      [{ text: "Bill 17", callback_data: "r:v:17" }],
      [{ text: "‹ Back", callback_data: "r:l:0" }],
      [{ text: "➕ Add", callback_data: "r:a" }, { text: "✕ Close", callback_data: "r:z" }],
    ]);
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

  it("pages the saved payments 8 at a time, with More › and ‹ Back", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, date: `2026-10-${String(i + 10)}` }),
    );
    const many = { ...empty, rows };
    expect(pickScreen(many, 0).keyboard.slice(-2).map((row) => row.map((b) => b.callback_data))).toEqual([["r:ar:8"], ["r:l:0", "r:z"]]);
    const second = pickScreen(many, 8).keyboard;
    expect(second).toHaveLength(3);
    expect(second.slice(-2).map((row) => row.map((b) => b.text))).toEqual([["‹ Back"], ["‹ All recurring", "✕ Close"]]);
    expect(second.at(-2)![0].callback_data).toBe("r:ar:0");
  });

  it("an add screen for a payment already in a series, or gone, says so", () => {
    const linked = { ...empty, series: [{ id: 4, name: "Gym" }], rows: [row({ seriesId: 4 })] } as unknown as Book;
    expect(addScreen(linked, TX).text).toBe("That payment is already in Gym.");
    expect(addScreen(empty, TX).text).toBe("That payment no longer exists.");
    expect(pickScreen(empty, 0).text).toContain("No saved payment is outside a series.");
  });
});

describe("adding a payment to a series it is worded unlike", () => {
  const PAYMENT = "22222222-2222-4222-8222-222222222222";
  let n = 0;
  const row = (over: Partial<BookRow>): BookRow => ({
    id: `11111111-1111-4111-8111-${String(++n).padStart(12, "0")}`, date: "2026-09-03", type: "expense",
    amount: "0.40", description: "x", merchantId: null, subcategoryId: null, incomeSourceId: null, fromAccountId: null,
    toAccountId: null, seriesId: null, flagged: false, merchant: null, source: null, ...over,
  });
  const series = (id: number, name: string, over: Partial<BookSeries> = {}): BookSeries => ({
    id, name, kind: "expense", cadence: "monthly", amountVaries: false, merchantId: null, subcategoryId: null,
    incomeSourceId: null, fromAccountId: null, toAccountId: null, keywords: [], subcategory: null, source: null,
    fromAccount: null, toAccount: null, ...over,
  });
  const monthly = (sid: number, day: string, amount: string, description: string) =>
    ["06", "07", "08"].map((m) => row({ date: `2026-${m}-${day}`, amount, description, seriesId: sid }));
  const payment = row({ id: PAYMENT, amount: "0.39", description: "Nimbus web services" });
  const book: Book = {
    series: [
      series(1, "Zebra plan"),
      series(2, "Nimbus storage"),
      series(3, "Streaming plan"),
      series(4, "Cloud hosting bill"),
      series(5, "Allowance", { kind: "income", incomeSourceId: 9 }),
      series(6, "Phone bill"),
    ],
    rows: [
      ...monthly(4, "03", "0.40", "Cloud hosting bill"),
      ...monthly(3, "20", "0.40", "Streaming plan"),
      ...monthly(2, "15", "50.00", "Nimbus storage"),
      ...monthly(6, "10", "45.00", "Phone bill"),
      payment,
    ],
    pauses: new Map(), skips: new Map(), excluded: new Map(), dismissed: [],
  };

  it("ranks the series of its kind by timing, then amount, then name, with no name required", () => {
    expect(joinable(book, payment).map((j) => [j.series.name, j.dateFits, j.amountFits])).toEqual([
      ["Cloud hosting bill", true, true],
      ["Streaming plan", false, true],
      ["Nimbus storage", false, false],
      ["Phone bill", false, false],
      ["Zebra plan", false, false],
    ]);
  });

  it("offers income only to series of its source, and a transfer only to series of its accounts", () => {
    const income = row({ type: "income", incomeSourceId: 9 });
    expect(joinable(book, income).map((j) => j.series.name)).toEqual(["Allowance"]);
    expect(joinable(book, { ...income, incomeSourceId: 8 })).toEqual([]);
    const transfers: Book = {
      ...book,
      series: [series(7, "Savings", { kind: "transfer", toAccountId: 2 }), series(8, "Card", { kind: "transfer", toAccountId: 3 })],
    };
    expect(joinable(transfers, row({ type: "transfer", toAccountId: 2 })).map((j) => j.series.name)).toEqual(["Savings"]);
  });

  it("lists the best 4 above the cadence rows, then All N series, and every series on request", () => {
    const screen = addScreen(book, PAYMENT);
    expect(screen.text.split("\n")[0]).toBe("<b>↻ Add to a series, or start a new one</b>");
    expect(screen.keyboard.slice(0, 5).map((r) => r.map((b) => b.text))).toEqual([
      ["↻ Add to Cloud hosting bill"],
      ["↻ Add to Streaming plan"],
      ["↻ Add to Nimbus storage"],
      ["↻ Add to Phone bill"],
      ["All 5 series ›"],
    ]);
    expect(screen.keyboard[0][0].callback_data).toBe(`r:aj:${PAYMENT}:4`);
    expect(screen.keyboard[4][0].callback_data).toBe(`r:ae:${PAYMENT}`);
    expect(screen.keyboard[5].map((b) => b.text)).toContain("Monthly");
    const all = addScreen(book, PAYMENT, true);
    expect(all.keyboard.filter((r) => r[0].text.startsWith("↻ Add to"))).toHaveLength(5);
    expect(all.keyboard.flat().map((b) => b.text)).not.toContain("All 5 series ›");
  });
});

describe("replies to a /recurring prompt", () => {
  const prompt = { text: "Rename #3 (Gym): reply with the new name.", date: 1000, from: { is_bot: true } };
  const reply = (over: Partial<PromptReply>): PromptReply => ({ text: "Home gym", date: 1010, reply_to_message: prompt, ...over });

  it.each([
    ["a photo", { photo: [{ file_id: "p" }] }],
    ["a voice note", { voice: { file_id: "v" } }],
    ["an audio file", { audio: { file_id: "a" } }],
    ["a document", { document: { file_id: "d" } }],
    ["a caption", { caption: "lunch 12" }],
    ["no text", { text: "  " }],
    ["a reply to a message that is not the bot's", { reply_to_message: { ...prompt, from: { is_bot: false } } }],
    ["a reply to a bot message that is not a prompt", { reply_to_message: { ...prompt, text: "Saved." } }],
    ["a prompt 15 minutes old", { date: 1000 + PROMPT_TTL_SECONDS }],
    ["no dates", { date: undefined }],
  ])("leaves %s to extraction", async (_, over) => {
    expect(await answerPrompt(reply(over as Partial<PromptReply>), 1, "tok", "2026-10-31")).toBe(false);
  });

  it("reads a typed pause end: a month and day is its next occurrence after the later of the start and today", () => {
    const today = "2026-10-31";
    expect(pauseEnd("Dec 15", "2025-09-15", today)).toBe("2026-12-15");
    expect(pauseEnd("Oct 31", "2026-10-31", today)).toBe("2027-10-31");
    expect(pauseEnd("Jan 5", "2026-12-01", "2026-11-15")).toBe("2027-01-05");
    expect(pauseEnd("Mar 1", "2027-03-01", today)).toBe("2028-03-01");
    expect(pauseEnd("2026-11-02", "2026-10-31", today)).toBe("2026-11-02");
    expect(pauseEnd("today", "2026-10-31", today)).toBe("2026-10-31");
    expect(pauseEnd("no idea", "2026-10-31", today)).toBeNull();
    expect(dayIn("2027-01-05", today)).toBe("Jan 5 2027");
    expect(dayIn("2026-12-15", today)).toBe("Dec 15");
  });

  it("reads a decimal amount or a currency marker as money, and plain digits in a name as none", () => {
    for (const text of ["lunch 12.50", "4,50 coffee", "$5", "5$", "5 dollars", "taxi 20 CAD", "€3 tip"]) {
      expect(hasMoney(text), text).toBe(true);
      expect(looksLikeExpense(text), text).toBe(true);
    }
    for (const text of ["Internet 2", "Gym 24", "Dec 15", "2026-11-02", "Home internet"]) {
      expect(hasMoney(text), text).toBe(false);
    }
  });

  it("reads an amount next to a non-date word as an expense, and a date as none", () => {
    expect(["12.50 lunch", "coffee 5", "$40 groceries", "gas 45,20"].map(looksLikeExpense)).toEqual([true, true, true, true]);
    expect(["Dec 15", "15 december", "Jan 32", "today", "Home internet", "Gym 2nd"].map(looksLikeExpense)).toEqual([
      false, false, false, false, false, false,
    ]);
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
    expect(parseRecurringTap("r:l:16", "2026-10-31")).toEqual({ op: "list", offset: 16 });
    expect(parseRecurringTap("r:v:4294967295", "2026-10-31")).toEqual({ op: "view", sid: 4294967295 });
    expect(parseRecurringTap("r:p:3", "2026-10-31")).toEqual({ op: "pause", sid: 3 });
    expect(parseRecurringTap("r:pf:3:20261023", "2026-10-31")).toEqual({ op: "pauseFrom", sid: 3, from: "2026-10-23" });
    expect(parseRecurringTap("r:pd:3:20261023", "2026-10-31")).toEqual({ op: "pauseDate", sid: 3, from: "2026-10-23" });
    expect(parseRecurringTap("r:pu:3:20261023:0", "2026-10-31")).toEqual({ op: "pauseUntil", sid: 3, from: "2026-10-23", until: null });
    expect(parseRecurringTap("r:pu:3:20261023:20270131", "2026-10-31")).toEqual({
      op: "pauseUntil", sid: 3, from: "2026-10-23", until: "2027-01-31",
    });
    expect(parseRecurringTap("r:u:3:20261031", "2026-10-31")).toEqual({ op: "resume", sid: 3, on: "2026-10-31" });
    // A "today" button resolves to the day it is tapped, not the day it was drawn.
    expect(parseRecurringTap("r:u:3:t", "2026-11-02")).toEqual({ op: "resume", sid: 3, on: "2026-11-02" });
    expect(parseRecurringTap("r:pf:3:t", "2026-11-02")).toEqual({ op: "pauseFrom", sid: 3, from: "2026-11-02" });
    expect(parseRecurringTap("r:pd:3:t", "2026-11-02")).toEqual({ op: "pauseDate", sid: 3, from: "2026-11-02" });
    expect(parseRecurringTap("r:pu:3:t:0", "2026-11-02")).toEqual({ op: "pauseUntil", sid: 3, from: "2026-11-02", until: null });
    expect(parseRecurringTap("r:n:3", "2026-10-31")).toEqual({ op: "rename", sid: 3 });
    expect(parseRecurringTap("r:x:3", "2026-10-31")).toEqual({ op: "askDelete", sid: 3 });
    expect(parseRecurringTap("r:xy:3", "2026-10-31")).toEqual({ op: "delete", sid: 3 });
    expect(parseRecurringTap("r:a", "2026-10-31")).toEqual({ op: "pick", offset: 0 });
    expect(parseRecurringTap("r:ar:8", "2026-10-31")).toEqual({ op: "pick", offset: 8 });
    expect(parseRecurringTap(`r:at:${TX}`, "2026-10-31")).toEqual({ op: "addFrom", tx: TX, all: false, from: "a" });
    expect(parseRecurringTap(`r:at:${TX}:s`, "2026-10-31")).toEqual({ op: "addFrom", tx: TX, all: false, from: "s" });
    expect(parseRecurringTap(`r:ae:${TX}:g`, "2026-10-31")).toEqual({ op: "addFrom", tx: TX, all: true, from: "g" });
    expect(parseRecurringTap(`r:ae:${TX}`, "2026-10-31")).toEqual({ op: "addFrom", tx: TX, all: true, from: "a" });
    expect(parseRecurringTap(`r:at:${TX}:x`, "2026-10-31")).toBeNull();
    expect(parseRecurringTap(`r:sv:${TX}`, "2026-10-31")).toEqual({ op: "saved", tx: TX, buttons: true });
    expect(parseRecurringTap(`r:sc:${TX}`, "2026-10-31")).toEqual({ op: "saved", tx: TX, buttons: false });
    expect(parseRecurringTap("r:z", "2026-10-31")).toEqual({ op: "close" });
    expect(parseRecurringTap(`r:aj:${TX}:4294967295`, "2026-10-31")).toEqual({ op: "join", tx: TX, sid: 4294967295 });
    expect(Buffer.byteLength(`r:aj:${TX}:4294967295`)).toBeLessThanOrEqual(64);
    expect(parseRecurringTap(`r:aj:${TX}`, "2026-10-31")).toBeNull();
    expect(parseRecurringTap("r:av", "2026-10-31")).toEqual({ op: "varies" });
    expect(parseRecurringTap(`r:ac:${TX}:s1`, "2026-10-31")).toEqual({ op: "create", tx: TX, cadence: "semimonthly", varies: true });
    expect(parseRecurringTap(`r:ac:${TX}:x1`, "2026-10-31")).toBeNull();
    expect(Buffer.byteLength(`r:ac:${TX}:y0`)).toBe(44);
    expect(parseRecurringTap("r:b", "2026-10-31")).toEqual({ op: "review", sid: null });
    expect(parseRecurringTap("r:b:7", "2026-10-31")).toEqual({ op: "review", sid: 7 });
    expect(parseRecurringTap(`r:bt:${TX}`, "2026-10-31")).toEqual({ op: "toggle", data: `r:bt:${TX}` });
    expect(parseRecurringTap(`r:ft:${TX}`, "2026-10-31")).toEqual({ op: "toggle", data: `r:ft:${TX}` });
    expect(parseRecurringTap("r:ba", "2026-10-31")).toEqual({ op: "all" });
    expect(parseRecurringTap("r:bk:7", "2026-10-31")).toEqual({ op: "apply", sid: 7 });
    expect(parseRecurringTap("r:bl", "2026-10-31")).toEqual({ op: "later" });
    expect(parseRecurringTap("r:f:8", "2026-10-31")).toEqual({ op: "flags", offset: 8 });
    expect(parseRecurringTap("r:fk", "2026-10-31")).toEqual({ op: "clear" });
    expect(parseRecurringTap("r:sg", "2026-10-31")).toEqual({ op: "suggestions" });
    expect(parseRecurringTap(`r:gd:${TX}`, "2026-10-31")).toEqual({ op: "dismiss", tx: TX });
    // The longest pause data, with a ten-digit series id, fits Telegram's 64 bytes.
    expect(Buffer.byteLength("r:pu:4294967295:20261023:20270131")).toBeLessThanOrEqual(64);
    for (const data of [undefined, "", "r:v:", "r:v:x", "r:l:12345", `c:${TX}`, "mt:1", "r:zz"]) {
      expect(parseRecurringTap(data, "2026-10-31"), String(data)).toBeNull();
    }
  });
});
