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
 */

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
function window(fit: Fit, centre: number): { start: number; end: number; lastDay: number } {
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
    const w = window(fit, c);
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
