import { describe, expect, it } from "vitest";
import {
  type Cadence,
  dayNumber,
  fitCadence,
  isoDate,
  occurrences,
  type Pause,
  shouldPropose,
  type SlotStatus,
  slots,
  suggestCadence,
} from "../src/recurring.js";

/** Dates every `step` days from `from`, `n` of them. */
function every(from: string, step: number, n: number): string[] {
  return Array.from({ length: n }, (_, i) => isoDate(dayNumber(from) + i * step));
}

/** Day `day` of month `month0` (0-based; 12 rolls into the next year). */
function monthDay(year: number, month0: number, day: number): string {
  return isoDate(Date.UTC(year, month0, day) / 86_400_000);
}

/** A small deterministic generator, so the property check is reproducible. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

/** The first slot centre of a fit on or after `day`. */
function nextCentre(fit: { anchor: Parameters<typeof slots>[0] }, day: string): string {
  return slots(fit.anchor, day, isoDate(dayNumber(day) + 400))[0];
}

/** The slot after the one the last payment settled. */
function nextAfterLast(fit: { anchor: Parameters<typeof slots>[0] }, dates: string[]): string {
  const last = dayNumber(dates[dates.length - 1]);
  const centres = slots(fit.anchor, isoDate(last - 40), isoDate(last + 400)).map(dayNumber);
  const settled = centres.reduce((a, b) => (Math.abs(b - last) < Math.abs(a - last) ? b : a));
  return isoDate(centres[centres.indexOf(settled) + 1]);
}

// The spec's worked examples (Phase 4.5 design §C.8), "today" 2026-10-31.
const INTERNET = ["2026-06-15", "2026-07-14", "2026-08-17", "2026-09-15", "2026-10-15"];
const MONTH_END = ["2026-06-30", "2026-08-01", "2026-09-01", "2026-09-30", "2026-10-30"];
const SALARY = every("2026-06-05", 14, 11); // Fridays Jun 5 .. Oct 23
const ALLOWANCE = [
  "2026-06-01", "2026-06-15", "2026-07-01", "2026-07-15", "2026-07-31",
  "2026-08-14", "2026-09-01", "2026-09-15", "2026-10-01", "2026-10-15",
];
const GROCERIES = [
  "2026-09-01", "2026-09-05", "2026-09-08", "2026-09-12", "2026-09-15",
  "2026-09-19", "2026-09-22", "2026-09-26", "2026-09-29", "2026-10-03",
];
const INTEREST = ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];
const GYM = ["2026-06-03", "2026-07-03", "2026-09-03", "2026-10-02"];
// Ledger coverage thins out: September was never logged.
const GAP = ["2026-06-15", "2026-07-15", "2026-08-15", "2026-10-15"];

// name, payments, cadence, score, spread, runner-up, its score, next slot after the last payment
const DETECTS: [string, string[], Cadence, number, number, Cadence, number, string][] = [
  ["a monthly bill with day jitter", INTERNET, "monthly", 1, 0, "semimonthly", 0.56, "2026-11-15"],
  ["a month-end charge that crosses the boundary", MONTH_END, "monthly", 1, 1.48, "semimonthly", 0.56, "2026-11-30"],
  ["a biweekly salary", SALARY, "biweekly", 1, 0, "weekly", 0.52, "2026-11-06"],
  ["a semi-monthly allowance shifted off weekends", ALLOWANCE, "semimonthly", 1, 0, "monthly", 0.5, "2026-11-01"],
  ["interest on the last day", INTEREST, "monthly", 1, 0, "semimonthly", 0.57, "2026-10-31"],
  ["a monthly gym with a missing month", GYM, "monthly", 0.8, 0, "quarterly", 0.5, "2026-11-03"],
  ["a monthly bill whose September was never logged", GAP, "monthly", 0.8, 0, "quarterly", 0.5, "2026-11-15"],
];

describe("cadence detection", () => {
  it.each(DETECTS)("detects %s", (_name, dates, cadence, score, spread, runnerUp, runnerScore, next) => {
    const { best, runnerUp: second } = suggestCadence(dates);
    expect(best).toMatchObject({ cadence, events: dates.length });
    expect(best!.score).toBeCloseTo(score, 2);
    expect(best!.spread).toBeCloseTo(spread, 2);
    expect(second!.cadence).toBe(runnerUp);
    expect(second!.score).toBeCloseTo(runnerScore, 2);
    expect(nextAfterLast(best!, dates)).toBe(next);
  });

  it("proposes a regular series with enough history, and not twice-a-week shopping", () => {
    expect(shouldPropose(suggestCadence(GYM).best!)).toBe(true);
    expect(shouldPropose(suggestCadence(INTERNET).best!)).toBe(true);
    const groceries = suggestCadence(GROCERIES).best!;
    expect(groceries.score).toBeLessThan(0.75);
    expect(shouldPropose(groceries)).toBe(false);
  });

  it("reads a gap in logging as a missing payment, not a change of cadence", () => {
    // An interval-based guess would see 61 days between Aug 15 and Oct 15.
    // Calendar slots keep the 15th: the gap lowers coverage, not the anchor.
    const fit = fitCadence("monthly", GAP);
    expect(fit.coverage).toBeCloseTo(0.8, 2);
    expect(fit.hit).toBe(1);
    expect(slots(fit.anchor, "2026-06-01", "2026-11-30")).toEqual([
      "2026-06-15", "2026-07-15", "2026-08-15", "2026-09-15", "2026-10-15", "2026-11-15",
    ]);
    // Thin coverage after August still fits the same anchor.
    expect(nextCentre(fitCadence("monthly", GAP.slice(0, 3)), "2026-10-31")).toBe("2026-11-15");
  });

  it("needs a full period of history before it suggests a cadence", () => {
    expect(suggestCadence([])).toEqual({ best: null, runnerUp: null });
    expect(suggestCadence(["2026-10-15"])).toEqual({ best: null, runnerUp: null });
    // Two payments 19 days apart cannot show a monthly cadence yet.
    expect(suggestCadence(["2026-10-01", "2026-10-20"]).best?.cadence).not.toBe("monthly");
  });

  it("fits the owner's declared cadence to a single payment", () => {
    // A bill logged once still has the cadence the owner confirmed.
    const fit = fitCadence("monthly", ["2026-10-15"]);
    expect(fit).toMatchObject({ events: 1, hit: 1, lowConfidence: true });
    expect(nextCentre(fit, "2026-10-31")).toBe("2026-11-15");
  });

  it("labels a yearly series with two payments low confidence", () => {
    const { best } = suggestCadence(["2025-03-10", "2026-03-12"]);
    expect(best).toMatchObject({ cadence: "yearly", lowConfidence: true });
    expect(shouldPropose(best!)).toBe(true);
    expect(nextCentre(best!, "2026-10-31")).toBe("2027-03-10");
  });

  it("clamps a last-day anchor to February, in a leap year too", () => {
    const fit = fitCadence("monthly", ["2027-11-30", "2027-12-31", "2028-01-31"]);
    expect(slots(fit.anchor, "2027-02-01", "2027-03-31")).toEqual(["2027-02-28", "2027-03-31"]);
    expect(slots(fit.anchor, "2028-02-01", "2028-03-31")).toEqual(["2028-02-29", "2028-03-31"]);
  });

  it("keeps the earliest anchor when two fit equally well", () => {
    // The 14th and the 16th: anchors 14, 15 and 16 all cost two days.
    const fit = fitCadence("monthly", ["2026-06-14", "2026-07-16"]);
    expect(nextCentre(fit, "2026-10-31")).toBe("2026-11-14");
  });

  it("fits weekly and quarterly phases", () => {
    const weekly = suggestCadence(every("2026-09-07", 7, 8)).best!;
    expect(weekly).toMatchObject({ cadence: "weekly", score: 1 });
    expect(nextCentre(weekly, "2026-10-31")).toBe("2026-11-02");
    const quarterly = suggestCadence(["2026-01-20", "2026-04-21", "2026-07-20", "2026-10-19"]).best!;
    expect(quarterly).toMatchObject({ cadence: "quarterly", score: 1 });
    expect(nextCentre(quarterly, "2026-10-31")).toBe("2027-01-20");
  });

  it("fits only the most recent 12 payments, so a moved due day takes over", () => {
    const fifth = Array.from({ length: 12 }, (_, m) => monthDay(2025, m, 5));
    const twentieth = Array.from({ length: 7 }, (_, m) => monthDay(2026, m, 20));
    const fit = fitCadence("monthly", [...fifth, ...twentieth]);
    expect(fit.events).toBe(12);
    expect(nextCentre(fit, "2026-07-21")).toBe("2026-08-20");
  });

  it("suggests monthly for any regular monthly series with up to two days of jitter", () => {
    const random = seeded(42);
    for (let run = 0; run < 100; run++) {
      const day = 1 + Math.floor(random() * 28);
      const n = 4 + Math.floor(random() * 9);
      const dates = Array.from({ length: n }, (_, m) =>
        isoDate(dayNumber(monthDay(2026, m, day)) + Math.floor(random() * 5) - 2),
      );
      expect(suggestCadence(dates).best?.cadence, dates.join(" ")).toBe("monthly");
    }
  });
});

/** Payments with ids p0, p1, ... in date order. */
function paid(dates: string[]): { id: string; date: string }[] {
  return dates.map((date, i) => ({ id: `p${i}`, date }));
}

function track(
  cadence: Cadence,
  dates: string[],
  today: string,
  pauses: Pause[] = [],
  skips: string[] = [],
) {
  return occurrences({ cadence, payments: paid(dates), pauses, skips, today });
}

function missed(o: ReturnType<typeof occurrences>): string[] {
  return o.slots.filter((s) => s.status === "missed").map((s) => s.due);
}

// name, cadence, payments, today, slot, window start, end, last day before missed, status
const PREDICTS: [string, Cadence, string[], string, string, string, string, string, SlotStatus][] = [
  ["a monthly bill due on a Sunday", "monthly", INTERNET, "2026-10-31", "2026-11-15", "2026-11-13", "2026-11-17", "2026-11-20", "upcoming"],
  ["a month-end charge, its window widened by the jitter", "monthly", MONTH_END, "2026-10-31", "2026-11-30", "2026-11-27", "2026-12-03", "2026-12-06", "upcoming"],
  ["a salary whose window ends on a Saturday", "biweekly", SALARY, "2026-10-31", "2026-11-06", "2026-11-05", "2026-11-09", "2026-11-11", "upcoming"],
  ["an allowance whose window opens on a Saturday", "semimonthly", ALLOWANCE, "2026-10-31", "2026-11-01", "2026-10-30", "2026-11-02", "2026-11-04", "due"],
  ["interest due today", "monthly", INTEREST, "2026-10-31", "2026-10-31", "2026-10-29", "2026-11-02", "2026-11-05", "due"],
  ["a gym due now", "monthly", GYM, "2026-10-31", "2026-11-03", "2026-10-30", "2026-11-05", "2026-11-08", "due"],
  ["a gym month never logged", "monthly", GYM, "2026-10-31", "2026-08-03", "2026-07-31", "2026-08-05", "2026-08-08", "missed"],
  ["a bill logged once, with the default window", "monthly", ["2026-10-15"], "2026-10-31", "2026-11-15", "2026-11-12", "2026-11-18", "2026-11-21", "upcoming"],
];

describe("expected payments", () => {
  it.each(PREDICTS)("predicts %s", (_name, cadence, dates, today, due, start, end, lastDay, status) => {
    const slot = track(cadence, dates, today).slots.find((s) => s.due === due);
    expect(slot).toMatchObject({ start, end, lastDay, status });
  });

  it("counts a missed payment only after its window and grace", () => {
    const lostJob = SALARY.slice(0, -1); // no pay on Oct 23
    expect(missed(track("biweekly", lostJob, "2026-10-28"))).toEqual([]);
    expect(missed(track("biweekly", lostJob, "2026-10-29"))).toEqual(["2026-10-23"]);
    expect(missed(track("monthly", GYM, "2026-10-31"))).toEqual(["2026-08-03"]);
  });

  it("never counts a paused slot as missed", () => {
    // Salary stops: the owner pauses it since the first missing pay.
    const lostJob = SALARY.slice(0, -1);
    const paused = track("biweekly", lostJob, "2026-10-29", [{ from: "2026-10-23", until: null }]);
    expect(missed(paused)).toEqual([]);
    expect(paused.slots.filter((s) => s.status === "paused").map((s) => s.due)).toEqual([
      "2026-10-23", "2026-11-06",
    ]);

    // A phone bill paused for two months, then resumed.
    const phone = ["2026-06-15", "2026-07-15", "2026-08-14"];
    const pause = [{ from: "2026-09-01", until: "2026-10-28" }];
    const resumed = track("monthly", phone, "2026-10-31", pause);
    expect(missed(resumed)).toEqual([]);
    expect(resumed.slots.map((s) => [s.due, s.status])).toEqual([
      ["2026-06-15", "met"], ["2026-07-15", "met"], ["2026-08-15", "met"],
      ["2026-09-15", "paused"], ["2026-10-15", "paused"], ["2026-11-15", "upcoming"],
    ]);
    expect(missed(track("monthly", phone, "2026-10-31"))).toEqual(["2026-09-15", "2026-10-15"]);
  });

  it("pauses a slot whose centre is the pause's first day, and expects one on its resume day", () => {
    const o = track("monthly", INTERNET, "2026-12-31", [{ from: "2026-11-15", until: "2026-12-15" }]);
    const status = Object.fromEntries(o.slots.map((s) => [s.due, s.status]));
    expect(status["2026-11-15"]).toBe("paused");
    expect(status["2026-12-15"]).toBe("missed");
  });

  it("lets a skip settle the one payment that will not happen", () => {
    const o = track("monthly", GYM, "2026-10-31", [], ["2026-08-03"]);
    expect(missed(o)).toEqual([]);
    expect(o.slots.find((s) => s.due === "2026-08-03")?.status).toBe("skipped");
    // A skip near a slot that was paid anyway changes nothing.
    expect(track("monthly", GYM, "2026-10-31", [], ["2026-09-04"]).slots.find((s) => s.due === "2026-09-03")?.status).toBe("met");
  });

  it("counts a payment logged during a pause as met and flags it, and reports a second payment in one slot", () => {
    const o = track("monthly", [...INTERNET, "2026-10-16"], "2026-10-31", [{ from: "2026-10-01", until: null }]);
    expect(o.slots.find((s) => s.due === "2026-10-15")).toMatchObject({ status: "met", paymentId: "p4", duringPause: true });
    expect(o.extra).toEqual(["p5"]);
  });

  it("expects nothing from a series with no payment yet", () => {
    expect(occurrences({ cadence: "monthly", payments: [], pauses: [], skips: [], today: "2026-10-31" })).toEqual({
      fit: null, slots: [], extra: [],
    });
  });

  it("never counts a slot inside a pause as missed, for any monthly series and pause", () => {
    const random = seeded(7);
    for (let run = 0; run < 100; run++) {
      const day = 1 + Math.floor(random() * 28);
      const dates = Array.from({ length: 3 + Math.floor(random() * 6) }, (_, m) =>
        isoDate(dayNumber(monthDay(2026, m, day)) + Math.floor(random() * 5) - 2),
      );
      const from = isoDate(dayNumber(dates[dates.length - 1]) + Math.floor(random() * 60));
      const until = random() < 0.5 ? null : isoDate(dayNumber(from) + 1 + Math.floor(random() * 90));
      const o = track("monthly", dates, "2026-12-31", [{ from, until }]);
      for (const s of o.slots) {
        const inside = s.due >= from && (until === null || s.due < until);
        if (inside) expect(s.status, `${dates.join(" ")} paused ${from}..${until}`).not.toBe("missed");
      }
    }
  });
});
