import { describe, expect, it } from "vitest";
import { renderDigest } from "../src/recurring-digest.js";
import type { Book, BookRow, BookSeries } from "../src/recurring-db.js";
import type { Cadence, Kind } from "../src/recurring.js";

// The design's §C.8 fixtures, as the digest reads them on Sat Oct 31 2026.

let next = 0;
function row(seriesId: number | null, date: string, amount: string, over: Partial<BookRow> = {}): BookRow {
  return {
    id: `row-${++next}`,
    date,
    type: "expense",
    amount,
    description: "",
    merchantId: null,
    subcategoryId: null,
    incomeSourceId: null,
    fromAccountId: null,
    toAccountId: null,
    seriesId,
    flagged: seriesId !== null,
    merchant: null,
    source: null,
    ...over,
  };
}

function series(id: number, name: string, kind: Kind, cadence: Cadence, over: Partial<BookSeries> = {}): BookSeries {
  return {
    id,
    name,
    kind,
    cadence,
    amountVaries: false,
    merchantId: null,
    subcategoryId: null,
    incomeSourceId: null,
    fromAccountId: null,
    toAccountId: null,
    keywords: [],
    subcategory: null,
    source: null,
    fromAccount: null,
    toAccount: null,
    ...over,
  };
}

const ALLOWANCE = 1;
const INTEREST = 2;
const GYM = 3;
const SALARY = 4;
const INTERNET = 5;

const income = (sid: number, source: number, date: string, amount: string) =>
  row(sid, date, amount, { type: "income", incomeSourceId: source, description: "Deposit" });
const gym = (date: string, sid: number | null = GYM) =>
  row(sid, date, "25.00", { description: "Gym", subcategoryId: 10 });
const internet = (date: string, sid: number | null) =>
  row(sid, date, "64.99", { description: "Internet bill", subcategoryId: 20 });
const streaming = (date: string) => row(null, date, "9.99", { description: "Music streaming", subcategoryId: 30 });

const FRIDAYS = ["06-05", "06-19", "07-03", "07-17", "07-31", "08-14", "08-28", "09-11", "09-25", "10-09", "10-23"];

function mockBook(): Book {
  const rows = [
    ...["06-01", "06-15", "07-01", "07-15", "07-31", "08-14", "09-01", "09-15", "10-01", "10-15"].map((d) =>
      income(ALLOWANCE, 2, `2026-${d}`, "150.00"),
    ),
    ...[
      ["06-30", "3.12"],
      ["07-31", "3.40"],
      ["08-31", "3.38"],
      ["09-30", "3.55"],
    ].map(([d, a]) => income(INTEREST, 3, `2026-${d}`, a)),
    ...["2026-06-03", "2026-07-03", "2026-09-03", "2026-10-02"].map((d) => gym(d)),
    ...FRIDAYS.map((d) => income(SALARY, 1, `2026-${d}`, d === "08-28" ? "1400.00" : "2000.00")),
    // Three past bills that look like the series but are not linked yet.
    ...["2026-05-15", "2026-06-15", "2026-07-14"].map((d) => internet(d, null)),
    ...["2026-08-17", "2026-09-15", "2026-10-15"].map((d) => internet(d, INTERNET)),
    // An untracked monthly charge: the detector's one proposal.
    ...["2026-07-05", "2026-08-05", "2026-09-05", "2026-10-05"].map(streaming),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return {
    series: [
      series(ALLOWANCE, "Allowance", "income", "semimonthly", { incomeSourceId: 2 }),
      series(GYM, "Gym", "expense", "monthly", { subcategoryId: 10 }),
      series(INTERNET, "Internet bill", "expense", "monthly", { subcategoryId: 20 }),
      series(SALARY, "Salary", "income", "biweekly", { incomeSourceId: 1 }),
      series(INTEREST, "Savings interest", "income", "monthly", { incomeSourceId: 3, amountVaries: true }),
    ],
    rows,
    pauses: new Map(),
    skips: new Map(),
    excluded: new Map(),
    dismissed: [],
  };
}

describe("renderDigest", () => {
  it("renders the design's Oct 31 digest: due now, coming up, not logged, review and suggestion counts", () => {
    const digest = renderDigest({ book: mockBook(), today: "2026-10-31" })!;
    expect(digest.text).toBe(
      [
        "<b>↻ Recurring · Sat Oct 31</b>",
        "",
        "<b>Due now</b>",
        "💰 <b>Savings interest</b> — amount varies, log it when it posts (by Nov 2)",
        "💰 <b>Allowance</b> — ~150.00, Oct 30–Nov 2",
        "💳 <b>Gym</b> — ~25.00, Oct 30–Nov 5",
        "",
        "<b>Coming up (7 days)</b>",
        "<blockquote>Nov 5–9  Salary — ~2,000.00</blockquote>",
        "",
        "<b>Not logged · 1</b>",
        "⚠️ <b>Gym</b> — around Aug 3, nothing logged by Aug 8",
        "",
        "🧹 3 past payments look like Internet bill",
        "🔎 1 possible new recurring item",
      ].join("\n"),
    );
    expect(digest.keyboard).toEqual([
      [
        { text: "🔍 Savings interest: logged?", callback_data: "r:df:2:20261031" },
        { text: "⏭ Skip", callback_data: "r:dk:2:20261031" },
      ],
      [
        { text: "🔍 Allowance: logged?", callback_data: "r:df:1:20261101" },
        { text: "⏭ Skip", callback_data: "r:dk:1:20261101" },
      ],
      [
        { text: "🔍 Gym Nov 3: logged?", callback_data: "r:df:3:20261103" },
        { text: "⏭ Skip", callback_data: "r:dk:3:20261103" },
      ],
      [
        { text: "🔍 Gym Aug 3: logged?", callback_data: "r:df:3:20260803" },
        { text: "⏭ Skip", callback_data: "r:dk:3:20260803" },
        { text: "⏸", callback_data: "r:p:3" },
      ],
      [
        { text: "🧹 Review (3)", callback_data: "r:b" },
        { text: "🔎 Suggestions (1)", callback_data: "r:sg" },
      ],
      [{ text: "↻ All recurring", callback_data: "r:l:0" }],
    ]);
    // Nothing became new that day: the windows opened earlier, the gap is old.
    expect(digest.ring).toBe(false);
  });

  it("rings when a fixed expense's window opens or a payment turns not logged, never for income or a varying amount", () => {
    // Oct 29: only the interest window opens (income, amount varies).
    expect(renderDigest({ book: mockBook(), today: "2026-10-29" })!.ring).toBe(false);
    // Oct 30: the allowance (income) and the gym (a fixed expense) open.
    expect(renderDigest({ book: mockBook(), today: "2026-10-30" })!.ring).toBe(true);
    // Aug 9: the gym's Aug 3 payment is past its last day.
    expect(renderDigest({ book: mockBook(), today: "2026-08-09" })!.ring).toBe(true);
    expect(renderDigest({ book: mockBook(), today: "2026-08-10" })!.ring).toBe(false);
  });

  it("is null when nothing is due, coming, not logged or left to review", () => {
    const book = mockBook();
    book.series = book.series.filter((s) => s.id === SALARY);
    book.rows = book.rows.filter((r) => r.seriesId === SALARY);
    // Oct 25: the Oct 23 pay is logged and the next window opens Nov 5.
    expect(renderDigest({ book, today: "2026-10-25" })).toBeNull();
    expect(renderDigest({ book, today: "2026-10-29" })!.text).toContain("Nov 5–9  Salary");
  });

  it("never lists a paused slot as not logged", () => {
    const book = mockBook();
    book.pauses.set(GYM, [{ from: "2026-07-20", until: "2026-08-20" }]);
    expect(renderDigest({ book, today: "2026-10-31" })!.text).not.toContain("Not logged");
  });

  it("shows a skip made since the digest's day as skipped with Undo, and drops it from the count", () => {
    const book = mockBook();
    book.skips.set(GYM, ["2026-08-03"]);
    const digest = renderDigest({ book, today: "2026-10-31", skipped: [{ seriesId: GYM, due: "2026-08-03" }] })!;
    expect(digest.text).toContain("<b>Not logged · 0</b>\n✓ <b>Gym</b> · Aug 3 skipped");
    expect(digest.keyboard).toContainEqual([{ text: "↩ Undo skip: Gym Aug 3", callback_data: "r:du:3:20260803" }]);
    // An older skip is simply settled: no row at all.
    expect(renderDigest({ book, today: "2026-10-31" })!.text).not.toContain("Aug 3");
  });

  it("shows 10 not-logged rows, folds the rest into an expandable quote, and notes a day with no digest", () => {
    const book = mockBook();
    // A weekly series logged once, a year back: every week since is not logged.
    book.series.push(series(9, "Cleaner", "expense", "weekly"));
    book.rows.unshift(row(9, "2025-10-01", "40.00", { description: "Cleaner" }));
    const digest = renderDigest({ book, today: "2026-10-31", noDigestOn: "2026-10-30" })!;
    const section = digest.text.split("\n\n").find((s) => s.startsWith("<b>Not logged"))!;
    const lines = section.split("\n");
    expect(lines[0]).toMatch(/^<b>Not logged · \d+<\/b>$/);
    expect(lines.slice(1, 11).every((l) => l.startsWith("⚠️"))).toBe(true);
    expect(lines[11]).toMatch(/^<blockquote expandable>⚠️/);
    expect(digest.text.endsWith("⚠️ No digest on Oct 30")).toBe(true);
    // Under Telegram's limit as the reader sees it, and at most 6 item rows of buttons.
    expect(digest.text.replace(/<[^>]*>/g, "").length).toBeLessThanOrEqual(3500);
    expect(digest.keyboard.filter((r) => r.some((b) => b.callback_data.startsWith("r:d"))).length).toBe(6);
  });

  it("cuts the folded rows to fit and says how many more there are", () => {
    const book = mockBook();
    for (let i = 0; i < 4; i++) {
      book.series.push(series(20 + i, `Weekly chore ${"x".repeat(30)} ${i}`, "expense", "weekly"));
      book.rows.unshift(row(20 + i, "2024-11-01", "40.00", { description: `Chore ${i}` }));
    }
    const text = renderDigest({ book, today: "2026-10-31" })!.text;
    expect(text.replace(/<[^>]*>/g, "").length).toBeLessThanOrEqual(3500);
    expect(text).toMatch(/\n\+\d+ more in \/recurring\n/);
  });

  it("escapes names for HTML", () => {
    const book = mockBook();
    book.series.find((s) => s.id === GYM)!.name = "Gym <A&B>";
    expect(renderDigest({ book, today: "2026-10-31" })!.text).toContain("💳 <b>Gym &lt;A&amp;B&gt;</b> — ~25.00");
  });
});
