/**
 * Recurring series: cadence detection over a payment history. Pure functions:
 * no network, no database, no clock (callers pass `today`). Dates are Toronto
 * calendar dates as `YYYY-MM-DD`, turned into integer day numbers inside.
 *
 * How a history is read (Phase 4.5 design §C):
 *
 * - Expected payments are **calendar slots** (the 15th, the last day, every
 *   other Friday), never "last payment + 30 days". Each cadence tries every
 *   anchor and keeps the one with the lowest total distance from payments to
 *   their nearest slot, each distance capped at half a period, so the anchor
 *   is median-like and one odd payment cannot drag it.
 * - **A gap is a missing payment, not a cadence change.** A month the owner
 *   did not log is an empty slot: it lowers `coverage` (and later counts as
 *   not logged), but the anchor stays on the same calendar day because the
 *   payments either side still sit on it. Thin logging after a date therefore
 *   never turns a monthly bill into a quarterly one. Only payments landing on
 *   a different day move the anchor, and only once they outweigh the old day
 *   among the most recent 12 payments (or 400 days).
 * - `score = hit × coverage`: hit is the share of payments on a slot, coverage
 *   the share of slots (outside pauses) with a payment. Coverage stops a too
 *   short period winning, hit a too long one.
 * - A cadence is suggested only once the history spans one full period of
 *   it. With less, the owner's declared cadence (`recurring_series.cadence`)
 *   is what the series uses; `fitCadence` fits an anchor to it from as little
 *   as one payment.
 * - **Descriptions are compared as word sets** (`tokens`, `textSimilarity`):
 *   case, order, punctuation, digits, month names and filler words ("bill",
 *   "plan", "monthly") are ignored, so "Internet bill" and "Home internet
 *   plan" are one payment. Most expenses have no merchant, so an expense
 *   series matches on its name, keywords and every description already
 *   linked to it, never on one exact string or on the merchant alone.
 */

import { merchantKey } from "./commands.js";
import { parseCents } from "./extraction.js";

export type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "yearly";

interface Rule {
  /** Nominal period in days. */
  period: number;
  /** A payment within this many days of a slot is on it. */
  tolerance: number;
  /** Fewest payments before the detector proposes an undeclared series. */
  minEvents: number;
  /** Window half-width in days: [min, max, default with fewer than 3 payments]. */
  half: [number, number, number];
  /** Grace after the window before a payment counts as missed: [min, max]. */
  grace: [number, number];
}

// Grace floors cover a card charge posting 1-2 business days late, a weekend
// and a day of logging lag; ceilings stay under a quarter period, so one
// missed payment is reported before the next one's window opens (§C.6).
const RULES: Record<Cadence, Rule> = {
  weekly: { period: 7, tolerance: 1, minEvents: 4, half: [1, 2, 1], grace: [1, 2] },
  biweekly: { period: 14, tolerance: 2, minEvents: 4, half: [1, 3, 2], grace: [2, 3] },
  semimonthly: { period: 15.2, tolerance: 3, minEvents: 4, half: [1, 3, 2], grace: [2, 3] },
  monthly: { period: 30.4, tolerance: 4, minEvents: 3, half: [2, 5, 3], grace: [3, 7] },
  quarterly: { period: 91.3, tolerance: 7, minEvents: 3, half: [3, 10, 5], grace: [5, 14] },
  yearly: { period: 365, tolerance: 10, minEvents: 2, half: [5, 14, 7], grace: [7, 21] },
};

/** Shortest period first. */
const CADENCES = Object.keys(RULES) as Cadence[];

/**
 * Where a cadence's slots fall. Weekly and biweekly: day number mod 7 or 14.
 * The others: every month in `months` (0-11), on each of `days`, where a day
 * is 1..28 from the start of the month or -1..-4 from its end (-1 = last day),
 * so "the last day" is the 28th in February and the 31st in March.
 */
export type Anchor =
  | { cadence: "weekly" | "biweekly"; phase: number }
  | { cadence: "semimonthly" | "monthly" | "quarterly" | "yearly"; months: number[]; days: number[] };

export interface Fit {
  cadence: Cadence;
  anchor: Anchor;
  /** hit × coverage, 0..1. */
  score: number;
  hit: number;
  coverage: number;
  /** Robust spread of payments around their slots, in days: 1.4826 × MAD. */
  spread: number;
  /** Payments the fit used (the most recent 12, within 400 days). */
  events: number;
  /** Days from the first to the last of those payments. */
  spanDays: number;
  /** Fewer than three payments: a cadence the owner confirms, not one the history shows. */
  lowConfidence: boolean;
}

/** A dated pause, [from, until); until null = still paused. */
export interface Pause {
  from: string;
  until: string | null;
}

const DAY_MS = 86_400_000;
const RECENT_EVENTS = 12;
const RECENT_DAYS = 400;

export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export function isoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

const ALL_MONTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DAY_ANCHORS = [...Array.from({ length: 28 }, (_, i) => i + 1), -1, -2, -3, -4];

function dayOfMonth(year: number, month0: number, anchor: number): number {
  if (anchor > 0) return Date.UTC(year, month0, anchor) / DAY_MS;
  return Date.UTC(year, month0 + 1, 1 + anchor) / DAY_MS; // day 0 of next month = last day
}

function slotDays(anchor: Anchor, from: number, to: number): number[] {
  if ("phase" in anchor) {
    const p = RULES[anchor.cadence].period;
    const out: number[] = [];
    for (let d = from + ((((anchor.phase - from) % p) + p) % p); d <= to; d += p) out.push(d);
    return out;
  }
  const out: number[] = [];
  const start = new Date(from * DAY_MS);
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); ; m++) {
    if (m === 12) [y, m] = [y + 1, 0];
    if (Date.UTC(y, m, 1) / DAY_MS > to) break;
    if (!anchor.months.includes(m)) continue;
    for (const a of anchor.days) {
      const d = dayOfMonth(y, m, a);
      if (d >= from && d <= to) out.push(d);
    }
  }
  return out.sort((a, b) => a - b);
}

/** The slot centres of an anchor from `from` to `to`, inclusive. */
export function slots(anchor: Anchor, from: string, to: string): string[] {
  return slotDays(anchor, dayNumber(from), dayNumber(to)).map(isoDate);
}

/** A day anchor's position in a 31-day month, for spacing semi-monthly pairs. */
function nominal(a: number): number {
  return a > 0 ? a : 32 + a;
}

function candidates(cadence: Cadence): Anchor[] {
  switch (cadence) {
    case "weekly":
    case "biweekly":
      return Array.from({ length: RULES[cadence].period }, (_, phase) => ({ cadence, phase }));
    case "monthly":
      return DAY_ANCHORS.map((d) => ({ cadence, months: ALL_MONTHS, days: [d] }));
    case "semimonthly":
      return DAY_ANCHORS.flatMap((a) =>
        DAY_ANCHORS.filter((b) => nominal(b) - nominal(a) >= 10 && nominal(b) - nominal(a) <= 20).map(
          (b) => ({ cadence, months: ALL_MONTHS, days: [a, b] }),
        ),
      );
    case "quarterly":
      return [0, 1, 2].flatMap((q) =>
        DAY_ANCHORS.map((d) => ({ cadence, months: [q, q + 3, q + 6, q + 9], days: [d] })),
      );
    case "yearly":
      return ALL_MONTHS.flatMap((m) => DAY_ANCHORS.map((d) => ({ cadence, months: [m], days: [d] })));
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The slot nearest `day` among sorted centres, as [centre, day − centre]. */
function nearest(centres: number[], day: number): [number, number] {
  let best = centres[0];
  for (const c of centres) if (Math.abs(day - c) < Math.abs(day - best)) best = c;
  return [best, day - best];
}

function inPause(day: number, pauses: Pause[]): boolean {
  return pauses.some(
    (p) => day >= dayNumber(p.from) && (p.until === null || day < dayNumber(p.until)),
  );
}

/** The payments a fit reads: the most recent 12, within 400 days of the latest. */
function recent(dates: string[]): number[] {
  const days = dates.map(dayNumber).sort((a, b) => a - b);
  const last = days[days.length - 1];
  return days.filter((d) => d > last - RECENT_DAYS).slice(-RECENT_EVENTS);
}

function evaluate(anchor: Anchor, days: number[], pauses: Pause[]) {
  const { period, tolerance } = RULES[anchor.cadence];
  const first = days[0];
  const last = days[days.length - 1];
  const centres = slotDays(anchor, first - Math.ceil(period), last + Math.ceil(period));
  const residuals = days.map((d) => nearest(centres, d)[1]);
  const cost = residuals.reduce((sum, r) => sum + Math.min(Math.abs(r), period / 2), 0);
  const expected = centres.filter(
    (c) => c >= first - tolerance && c <= last + tolerance && !inPause(c, pauses),
  );
  const covered = expected.filter((c) => days.some((d) => Math.abs(d - c) <= tolerance));
  return { residuals, cost, coverage: expected.length ? covered.length / expected.length : 0 };
}

/**
 * Fits the best anchor of one cadence to a payment history (at least one
 * date). Ties keep the anchor tried first: earlier phase, earlier day of
 * month, days from the start before days from the end.
 */
export function fitCadence(cadence: Cadence, dates: string[], pauses: Pause[] = []): Fit {
  const days = recent(dates);
  let best: { anchor: Anchor; e: ReturnType<typeof evaluate> } | null = null;
  for (const anchor of candidates(cadence)) {
    const e = evaluate(anchor, days, pauses);
    if (best === null || e.cost < best.e.cost) best = { anchor, e };
  }
  const { anchor, e } = best!;
  const hit = e.residuals.filter((r) => Math.abs(r) <= RULES[cadence].tolerance).length / days.length;
  const m = median(e.residuals);
  return {
    cadence,
    anchor,
    score: hit * e.coverage,
    hit,
    coverage: e.coverage,
    spread: 1.4826 * median(e.residuals.map((r) => Math.abs(r - m))),
    events: days.length,
    spanDays: days[days.length - 1] - days[0],
    lowConfidence: days.length < 3,
  };
}

/**
 * The best cadence for a history and the runner-up. Only cadences whose
 * period (less its tolerance) the history spans are tried, so one or two
 * close payments suggest nothing. Scores within 0.05 of the top prefer the
 * longer period: fewer predictions, fewer false "not logged".
 */
export function suggestCadence(
  dates: string[],
  pauses: Pause[] = [],
): { best: Fit | null; runnerUp: Fit | null } {
  if (dates.length < 2) return { best: null, runnerUp: null };
  const days = recent(dates);
  const span = days[days.length - 1] - days[0];
  const fits = CADENCES.filter((c) => span >= RULES[c].period - RULES[c].tolerance)
    .map((c) => fitCadence(c, dates, pauses))
    .sort((a, b) => b.score - a.score);
  if (fits.length === 0) return { best: null, runnerUp: null };
  const best = fits
    .filter((f) => f.score >= fits[0].score - 0.05)
    .reduce((a, b) => (RULES[b.cadence].period > RULES[a.cadence].period ? b : a));
  return { best, runnerUp: fits.find((f) => f !== best) ?? null };
}

/**
 * Whether the detector offers an undeclared series: score ≥ 0.75, at least
 * the cadence's minimum payments, spread over that many periods (less one
 * tolerance of jitter). Monthly needs 3 payments over about 2 months; yearly
 * 2 payments about a year apart, which a flat "two periods" would rule out.
 */
export function shouldPropose(fit: Fit): boolean {
  const { minEvents, period, tolerance } = RULES[fit.cadence];
  return (
    fit.score >= 0.75 &&
    fit.events >= minEvents &&
    fit.spanDays >= (minEvents - 1) * period - tolerance
  );
}

export type SlotStatus = "met" | "skipped" | "paused" | "upcoming" | "due" | "missed";

/** One expected payment: its centre, its window, and what happened to it. */
export interface Slot {
  due: string;
  /** Window [start, end]; the payment is due from start. */
  start: string;
  end: string;
  /** The last day before it counts as missed: end plus grace. */
  lastDay: string;
  status: SlotStatus;
  paymentId: string | null;
  /** Met by a payment logged while the series was paused ("resume?"). */
  duringPause: boolean;
}

function clamp(x: number, [min, max]: [number, number] | [number, number, number]): number {
  return Math.min(Math.max(x, min), max);
}

/** 0 = Sunday .. 6 = Saturday. */
function weekday(day: number): number {
  return new Date(day * DAY_MS).getUTCDay();
}

/**
 * The window around a slot centre: ±⌈2s⌉ days clamped to the cadence's
 * range (its default below three payments). A start on a weekend moves back
 * to Friday (pay lands early), an end on a weekend forward to Monday
 * (charges post on the next business day). Grace is ⌈s⌉ clamped. Holidays
 * are not modelled; the grace floor absorbs a one-day shift.
 */
function windowOf(fit: Fit, centre: number): { start: number; end: number; lastDay: number } {
  const { half, grace } = RULES[fit.cadence];
  const h = fit.events < 3 ? half[2] : clamp(Math.ceil(2 * fit.spread), half);
  let start = centre - h;
  let end = centre + h;
  if (weekday(start) === 6) start -= 1;
  if (weekday(start) === 0) start -= 2;
  if (weekday(end) === 6) end += 2;
  if (weekday(end) === 0) end += 1;
  return { start, end, lastDay: end + clamp(Math.ceil(fit.spread), grace) };
}

/**
 * Every expected payment of a series from its first payment to the first
 * slot after today, with its status: met (a payment within half a period,
 * oldest first, one per slot; a second goes in `extra`), skipped (a skip
 * settles the unpaid slot nearest its date), paused (centre inside a pause,
 * [from, until)), else upcoming before its window, due until its last day,
 * missed after. The anchor is fitted to the declared cadence, so a series
 * with one payment has slots too; one with none expects nothing yet. A
 * month the owner never logged is missed, never a reason to move the anchor.
 */
export function occurrences(input: {
  cadence: Cadence;
  payments: { id: string; date: string }[];
  skips: string[];
  pauses: Pause[];
  today: string;
}): { fit: Fit | null; slots: Slot[]; extra: string[] } {
  const { cadence, skips, pauses } = input;
  if (input.payments.length === 0) return { fit: null, slots: [], extra: [] };
  const payments = [...input.payments].sort((a, b) => a.date.localeCompare(b.date));
  const fit = fitCadence(cadence, payments.map((p) => p.date), pauses);
  const { period } = RULES[cadence];
  const today = dayNumber(input.today);
  const first = dayNumber(payments[0].date);
  const last = Math.max(today, dayNumber(payments[payments.length - 1].date));
  const all = slotDays(fit.anchor, first - Math.ceil(period), last + 2 * Math.ceil(period));
  const from = nearest(all, first)[0];
  const after = all.findIndex((c) => c > today && c >= from);
  const centres = all.slice(all.indexOf(from), after + 1);

  const held = new Map<number, string>();
  const extra: string[] = [];
  for (const p of payments) {
    const [c, r] = nearest(centres, dayNumber(p.date));
    if (Math.abs(r) <= period / 2 && !held.has(c)) held.set(c, p.id);
    else extra.push(p.id);
  }
  const skipped = new Set<number>();
  for (const s of skips) {
    const [c, r] = nearest(centres, dayNumber(s));
    if (Math.abs(r) <= period / 2 && !held.has(c)) skipped.add(c);
  }

  const slots = centres.map((c): Slot => {
    const w = windowOf(fit, c);
    const paused = inPause(c, pauses);
    const paymentId = held.get(c) ?? null;
    const status: SlotStatus = paymentId
      ? "met"
      : skipped.has(c)
        ? "skipped"
        : paused
          ? "paused"
          : today < w.start
            ? "upcoming"
            : today <= w.lastDay
              ? "due"
              : "missed";
    return {
      due: isoDate(c),
      start: isoDate(w.start),
      end: isoDate(w.end),
      lastDay: isoDate(w.lastDay),
      status,
      paymentId,
      duringPause: paymentId !== null && paused,
    };
  });
  return { fit, slots, extra };
}

/** The usual amount of a series and its band, in cents. */
export interface Band {
  typical: number;
  low: number;
  high: number;
}

/**
 * The median of the last 12 amounts and a band around it: from four amounts
 * on, the widest of 5 %, three robust spreads (3 × 1.4826 × MAD) or 1.00;
 * below four, 10 % or 1.00. None when the series' amount varies (interest).
 * Outside the band is a note on the card, never a refusal.
 */
export function amountBand(amounts: string[], varies = false): Band | null {
  if (varies) return null;
  const cents = amounts
    .slice(-RECENT_EVENTS)
    .map(parseCents)
    .filter((c): c is number => c !== null);
  if (cents.length === 0) return null;
  const typical = Math.round(median(cents));
  const mad = median(cents.map((c) => Math.abs(c - typical)));
  const half =
    cents.length >= 4
      ? Math.max(Math.round(typical * 0.05), Math.round(3 * 1.4826 * mad), 100)
      : Math.max(Math.round(typical * 0.1), 100);
  return { typical, low: typical - half, high: typical + half };
}

/** How far outside the band an amount is, in signed cents; null inside it. */
export function outsideBand(band: Band, amount: string): number | null {
  const cents = parseCents(amount);
  if (cents === null || (cents >= band.low && cents <= band.high)) return null;
  return cents - band.typical;
}

// Words that say nothing about which payment it is.
const NOISE = new Set([
  "an", "and", "at", "by", "for", "from", "in", "my", "of", "on", "our", "the", "this", "to", "with",
  "bill", "bills", "charge", "fee", "fees", "paid", "pay", "payment", "plan",
  "weekly", "biweekly", "monthly", "yearly", "annual", "week", "month", "year",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/**
 * The words of a description that identify a payment, sorted and unique:
 * the merchant key's normalisation (case, spacing, apostrophe style), then
 * words of two letters or more, without digits, month names or `NOISE`.
 * No stemming: "pass" and "passes" are different words.
 */
export function tokens(text: string): string[] {
  let found = TOKENS.get(text);
  if (!found) {
    const words = merchantKey(text).replace(/'/g, "").split(/[^\p{L}\p{N}]+/u);
    found = [...new Set(words.filter((w) => w.length > 1 && !/\d/.test(w) && !NOISE.has(w)))].sort();
    // A screen compares every description with every series' references.
    if (TOKENS.size >= 5000) TOKENS.clear();
    TOKENS.set(text, found);
  }
  return [...found];
}

const TOKENS = new Map<string, string[]>();

/** Two descriptions with at least this similarity name the same payment. */
const TEXT_MATCH = 0.6;

/**
 * How alike two descriptions are, 0..1: the mean of the word sets' Jaccard
 * index (shared / all) and overlap (shared / the smaller set). Overlap lets
 * "Internet bill" match "Home internet plan" (0.75); Jaccard keeps one
 * shared word in long descriptions from being enough ("Home internet" and
 * "Home hardware store", 0.375). Either set empty: 0.
 */
export function textSimilarity(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = tokens(b);
  if (x.size === 0 || y.length === 0) return 0;
  const shared = y.filter((t) => x.has(t)).length;
  return (shared / (x.size + y.length - shared) + shared / Math.min(x.size, y.length)) / 2;
}

export type Kind = "income" | "expense" | "transfer";

/** A saved transaction as matching reads it. */
export interface LedgerRow {
  id: string;
  date: string;
  type: Kind;
  amount: string;
  description: string;
  merchantId: number | null;
  /** The subcategory of the largest line; null on income and transfers. */
  subcategoryId: number | null;
  incomeSourceId: number | null;
  fromAccountId: number | null;
  toAccountId: number | null;
  seriesId: number | null;
}

/** A recurring_series row. */
export interface Series {
  id: number;
  name: string;
  kind: Kind;
  cadence: Cadence;
  amountVaries: boolean;
  merchantId: number | null;
  subcategoryId: number | null;
  incomeSourceId: number | null;
  fromAccountId: number | null;
  toAccountId: number | null;
  keywords: string[];
}

export interface SeriesHistory {
  series: Series;
  /** Its linked transactions. */
  linked: LedgerRow[];
  /** Ids the owner said are not this series. */
  excluded: string[];
  pauses: Pause[];
}

export type Strength = "strong" | "weak" | "none";

export interface Match {
  seriesId: number;
  strength: Strength;
  /** Days from the nearest expected payment; Infinity with no history. */
  slotDays: number;
  /** Cents from the usual amount; Infinity with no band. */
  amountCents: number;
}

/**
 * How well a transaction fits a series: strong (pre-ticked on review, linked
 * by default on the card), weak (shown unticked) or none. Never across kinds,
 * never a row linked elsewhere or excluded from this series.
 *
 * - income: the same income source; transfer: the same two accounts.
 * - expense, strong: the same merchant or a similar description (to the
 *   name, a keyword or any linked description), and either the amount within
 *   twice the band or the date inside an expected window plus grace.
 * - expense, weak: only the subcategory, with both the amount and the date.
 */
/**
 * A history's band and cadence fit, which do not depend on the transaction
 * matched: computed once per history object, so matching every row against
 * one history fits it once. A history is read, never mutated, by callers.
 */
const DERIVED = new WeakMap<SeriesHistory, { band: Band | null; fit: Fit | null }>();

function derived(history: SeriesHistory, linked: LedgerRow[]): { band: Band | null; fit: Fit | null } {
  let d = DERIVED.get(history);
  if (!d) {
    const { series: s } = history;
    d = {
      band: amountBand(linked.map((r) => r.amount), s.amountVaries),
      fit: linked.length > 0 ? fitCadence(s.cadence, linked.map((r) => r.date), history.pauses) : null,
    };
    DERIVED.set(history, d);
  }
  return d;
}

export function matchStrength(history: SeriesHistory, tx: LedgerRow): Match {
  const { series: s } = history;
  const linked = [...history.linked].sort((a, b) => a.date.localeCompare(b.date));
  // The cheap keys first: a screen matches every series against every row,
  // and the fit below is the costly part.
  const unrelated =
    tx.type !== s.kind ||
    tx.seriesId !== null ||
    history.excluded.includes(tx.id) ||
    (s.kind === "income" && tx.incomeSourceId !== s.incomeSourceId) ||
    (s.kind === "transfer" && (tx.fromAccountId !== s.fromAccountId || tx.toAccountId !== s.toAccountId));
  const none: Match = { seriesId: s.id, strength: "none", slotDays: Infinity, amountCents: Infinity };
  if (unrelated) return none;
  const refs = new Set([s.name, ...s.keywords, ...linked.map((r) => r.description)]);
  const named =
    s.kind === "expense" &&
    ((s.merchantId !== null && tx.merchantId === s.merchantId) ||
      [...refs].some((ref) => textSimilarity(ref, tx.description) >= TEXT_MATCH));
  const sameSub = s.kind === "expense" && s.subcategoryId !== null && tx.subcategoryId === s.subcategoryId;
  if (s.kind === "expense" && !named && !sameSub) return none;

  const { band, fit } = derived(history, linked);
  const cents = parseCents(tx.amount);
  const amountCents = band && cents !== null ? Math.abs(cents - band.typical) : Infinity;
  const amountFits = band !== null && amountCents <= 2 * (band.high - band.typical);

  let slotGap = Infinity;
  let dateFits = false;
  if (fit) {
    const day = dayNumber(tx.date);
    const p = Math.ceil(RULES[s.cadence].period);
    const [centre, r] = nearest(slotDays(fit.anchor, day - p, day + p), day);
    const w = windowOf(fit, centre);
    slotGap = Math.abs(r);
    dateFits = day >= w.start && day <= w.lastDay;
  }

  const match = (strength: Strength): Match => ({ seriesId: s.id, strength, slotDays: slotGap, amountCents });
  // Income and transfers got here only with their hard key.
  if (s.kind !== "expense") return match("strong");
  if (named && (amountFits || dateFits)) return match("strong");
  return match(sameSub && amountFits && dateFits ? "weak" : "none");
}

const RANK: Record<Strength, number> = { strong: 0, weak: 1, none: 2 };

function compare(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Of several series' matches for one transaction: stronger, then closer slot, then closer amount. */
export function bestMatch(matches: Match[]): Match | null {
  const live = matches
    .filter((m) => m.strength !== "none")
    .sort(
      (a, b) =>
        RANK[a.strength] - RANK[b.strength] ||
        compare(a.slotDays, b.slotDays) ||
        compare(a.amountCents, b.amountCents),
    );
  return live[0] ?? null;
}

/** A group of unlinked transactions that looks like an undeclared series. */
export interface Proposal {
  /** The `recurring_dismissed.group_key` that silences it. */
  key: string;
  kind: Kind;
  transactionIds: string[];
  fit: Fit;
}

/** Whether a row's amount is within twice the band of a group's amounts. */
function amountNear(group: LedgerRow[], row: LedgerRow): boolean {
  const band = amountBand(group.map((r) => r.amount));
  const cents = parseCents(row.amount);
  return band !== null && cents !== null && Math.abs(cents - band.typical) <= 2 * (band.high - band.typical);
}

/** The words more than half a description group shares, else its newest description's. */
function descKey(group: LedgerRow[]): string {
  const counts = new Map<string, number>();
  for (const r of group) for (const t of tokens(r.description)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const shared = [...counts].filter(([, n]) => n > group.length / 2).map(([t]) => t);
  return `desc:${(shared.length ? shared.sort() : tokens(group[group.length - 1].description)).join(" ")}`;
}

function dismissedKey(key: string, dismissed: string[]): boolean {
  if (dismissed.includes(key)) return true;
  return (
    key.startsWith("desc:") &&
    dismissed.some((d) => d.startsWith("desc:") && textSimilarity(d.slice(5), key.slice(5)) >= TEXT_MATCH)
  );
}

/**
 * Undeclared series in the last 400 days of transactions. Groups: income by
 * source (`income:<id>`), transfers by accounts (`transfer:<from or 0>:<to or
 * 0>`), expenses by merchant (`merchant:<id>`), and expenses with no merchant
 * by description: a row joins the first group holding a similar description
 * (`textSimilarity` ≥ 0.6) whose amounts its own is near (twice the band),
 * keyed `desc:<the words most of the group shares>`. A group is proposed when
 * none of it is linked to a series, its key (or for descriptions, a similar
 * one) was not dismissed, and its cadence fit passes `shouldPropose`.
 * Highest score first.
 */
export function proposeSeries(rows: LedgerRow[], dismissed: string[], today: string): Proposal[] {
  const end = dayNumber(today);
  const recentRows = rows
    .filter((r) => dayNumber(r.date) <= end && dayNumber(r.date) > end - RECENT_DAYS)
    .sort((a, b) => a.date.localeCompare(b.date));
  const keyed = new Map<string, LedgerRow[]>();
  const described: LedgerRow[][] = [];
  for (const r of recentRows) {
    const key =
      r.type === "income"
        ? `income:${r.incomeSourceId}`
        : r.type === "transfer"
          ? `transfer:${r.fromAccountId ?? 0}:${r.toAccountId ?? 0}`
          : r.merchantId !== null
            ? `merchant:${r.merchantId}`
            : null;
    if (key !== null) keyed.set(key, [...(keyed.get(key) ?? []), r]);
    else if (tokens(r.description).length > 0) {
      const home = described.find(
        (g) => g.some((m) => textSimilarity(m.description, r.description) >= TEXT_MATCH) && amountNear(g, r),
      );
      if (home) home.push(r);
      else described.push([r]);
    }
  }
  const groups: [string, LedgerRow[]][] = [...keyed, ...described.map((g): [string, LedgerRow[]] => [descKey(g), g])];
  return groups
    .filter(([key, g]) => g.every((r) => r.seriesId === null) && !dismissedKey(key, dismissed))
    .map(([key, g]) => ({ key, g, fit: suggestCadence(g.map((r) => r.date)).best }))
    .filter((p): p is { key: string; g: LedgerRow[]; fit: Fit } => p.fit !== null && shouldPropose(p.fit))
    .sort((a, b) => b.fit.score - a.fit.score || a.key.localeCompare(b.key))
    .map(({ key, g, fit }) => ({ key, kind: g[0].type, transactionIds: g.map((r) => r.id), fit }));
}
