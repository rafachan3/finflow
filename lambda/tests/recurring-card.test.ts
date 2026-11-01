import { describe, expect, it } from "vitest";
import { formatPreview } from "../src/extraction.js";
import { proposal } from "../src/recurring-card.js";
import type { Book, BookRow, BookSeries } from "../src/recurring-db.js";
import { reviewKeyboard, toggleCardSeries } from "../src/telegram.js";
import { expense } from "./integration/fixtures.js";

const CARD = "11111111-1111-4111-8111-111111111111";

function series(over: Partial<BookSeries>): BookSeries {
  return {
    id: 1, name: "Phone bill", kind: "expense", cadence: "monthly", amountVaries: false, merchantId: null,
    subcategoryId: 7, incomeSourceId: null, fromAccountId: null, toAccountId: null, keywords: [],
    subcategory: null, source: null, fromAccount: null, toAccount: null, ...over,
  };
}

function row(date: string, amount: string, over: Partial<BookRow> = {}): BookRow {
  return {
    id: `tx-${date}`, date, type: "expense", amount, description: "Phone bill", merchantId: null, subcategoryId: 7,
    incomeSourceId: null, fromAccountId: null, toAccountId: null, seriesId: 1, flagged: true, merchant: null,
    source: null, ...over,
  };
}

function book(s: BookSeries[], rows: BookRow[]): Book {
  return { series: s, rows, pauses: new Map(), skips: new Map(), excluded: new Map(), dismissed: [] };
}

// Design §C.8 row 7b: 45.00, 61.25 (one-off surcharge), 45.00 → band [40.50, 49.50].
const history = [row("2026-06-15", "45.00"), row("2026-07-15", "61.25"), row("2026-08-14", "45.00")];
const card = (amount: string, over: Partial<BookRow> = {}) =>
  row("2026-09-15", amount, { id: CARD, seriesId: null, flagged: false, ...over });

describe("the series a card proposes", () => {
  it("proposes a strong match, with a note only outside its band", () => {
    expect(proposal(book([series({})], history), card("45.00"))).toEqual({ id: 1, name: "Phone bill", note: null });
    expect(proposal(book([series({})], history), card("61.25"))).toEqual({
      id: 1,
      name: "Phone bill",
      note: "↻ Phone bill · usually 45.00; this is 61.25 (+16.25)",
    });
    expect(proposal(book([series({})], history), card("30.00"))?.note).toBe(
      "↻ Phone bill · usually 45.00; this is 30.00 (−15.00)",
    );
    expect(proposal(book([series({ amountVaries: true })], history), card("61.25"))?.note).toBeNull();
  });

  it("proposes nothing for a weak match, another kind or no series", () => {
    const sameSubOnly = card("45.00", { description: "Cable box rental" });
    expect(proposal(book([series({})], history), sameSubOnly)).toBeNull();
    expect(proposal(book([series({})], history), card("45.00", { type: "income", subcategoryId: null }))).toBeNull();
    expect(proposal(book([], []), card("45.00"))).toBeNull();
  });

  it("picks the closer of two series the payment matches", () => {
    const other = series({ id: 2, name: "Phone bill 2" });
    const rows = [...history, ...history.map((r) => ({ ...r, id: `${r.id}-b`, date: r.date.replace(/-1[45]$/, "-01"), seriesId: 2 }))];
    expect(proposal(book([other, series({})], rows), card("45.00"))?.id).toBe(1);
  });
});

describe("the card's recurring line and buttons", () => {
  const checks = { ok: true as const, errors: [], warnings: [] };

  it("names the series and its note, and otherwise Gemini's guess as a hint", () => {
    const lines = (text: string) => text.split("\n").filter((l) => /Recurring:|^↻/.test(l));
    expect(lines(formatPreview(expense(), checks, undefined, undefined, { name: "Phone bill", note: "↻ Phone bill · usually 45.00; this is 61.25 (+16.25)" }))).toEqual([
      "Funded by: self · Recurring: Phone bill",
      "↻ Phone bill · usually 45.00; this is 61.25 (+16.25)",
    ]);
    expect(lines(formatPreview(expense({ is_recurring: true }), checks))).toEqual(["Funded by: self · Recurring: not tracked yet"]);
    expect(lines(formatPreview(expense(), checks))).toEqual(["Funded by: self · Recurring: no"]);
  });

  it("links on Confirm with a toggle row, and the toggle swaps Confirm and its label only", () => {
    const keyboard = reviewKeyboard(CARD, { series: { id: 12, name: "Phone bill" } }).inline_keyboard;
    expect(keyboard).toEqual([
      [{ text: "Confirm", callback_data: `cr:${CARD}:12` }, { text: "Discard", callback_data: `d:${CARD}` }],
      [{ text: "Fix date", callback_data: `f:${CARD}` }, { text: "Edit", callback_data: `e:${CARD}` }],
      [{ text: "↻ Phone bill ✓", callback_data: `rt:${CARD}:12` }],
    ]);
    const off = toggleCardSeries(keyboard);
    expect(off).toEqual([
      [{ text: "Confirm", callback_data: `cx:${CARD}:12` }, keyboard[0][1]],
      keyboard[1],
      [{ text: "↻ not Phone bill", callback_data: `rt:${CARD}:12` }],
    ]);
    expect(toggleCardSeries(off)).toEqual(keyboard);
  });

  it("keeps a name starting with not, and a long one, through toggles", () => {
    const long = "not the internet bill for the cottage upstairs";
    const keyboard = reviewKeyboard(CARD, { series: { id: 1, name: long } }).inline_keyboard;
    const label = keyboard[2][0].text;
    expect(label).toBe("↻ not the internet bill for the… ✓");
    expect(toggleCardSeries(toggleCardSeries(keyboard))).toEqual(keyboard);
  });

  it("proposes no series on a card without Confirm, and fits 64 bytes with a ten-digit series id", () => {
    expect(reviewKeyboard(CARD, { confirm: false, series: { id: 1, name: "Phone bill" } }).inline_keyboard).toHaveLength(2);
    const data = reviewKeyboard(CARD, { series: { id: 4294967295, name: "Phone bill" } })
      .inline_keyboard.flat()
      .map((b) => Buffer.byteLength(b.callback_data));
    expect(Math.max(...data)).toBe(50);
    expect(toggleCardSeries(reviewKeyboard(CARD, { series: { id: 4294967295, name: "x" } }).inline_keyboard).flat()
      .every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
  });
});
