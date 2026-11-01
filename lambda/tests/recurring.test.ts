import { afterEach, describe, expect, it, vi } from "vitest";

// The module must stay pure: importing pg or calling the network fails.
vi.mock("pg", () => {
  throw new Error("recurring.ts must not import pg");
});

import {
  amountBand,
  bestMatch,
  type Cadence,
  dayNumber,
  fitCadence,
  isoDate,
  type LedgerRow,
  matchStrength,
  occurrences,
  outsideBand,
  type Pause,
  proposeSeries,
  type Series,
  shouldPropose,
  type SlotStatus,
  slots,
  suggestCadence,
  textSimilarity,
  tokens,
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
const PAYCHEQUE = [
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
  ["a semi-monthly paycheque shifted off weekends", PAYCHEQUE, "semimonthly", 1, 0, "monthly", 0.5, "2026-11-01"],
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
  ["a paycheque whose window opens on a Saturday", "semimonthly", PAYCHEQUE, "2026-10-31", "2026-11-01", "2026-10-30", "2026-11-02", "2026-11-04", "due"],
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

describe("amount band", () => {
  it("is the median plus or minus 5 %, three robust spreads or 1.00 from four payments on", () => {
    const salary = [...Array(10).fill("2000.00"), "1400.00"];
    const band = amountBand(salary)!;
    expect(band).toEqual({ typical: 200000, low: 190000, high: 210000 });
    expect(outsideBand(band, "1400.00")).toBe(-60000);
    expect(outsideBand(band, "2100.00")).toBeNull();
    expect(amountBand(Array(5).fill("64.99"))).toEqual({ typical: 6499, low: 6174, high: 6824 });
    // Spread wider than 5 %: three robust spreads of the amounts.
    expect(amountBand(["40.00", "50.00", "60.00", "50.00"])).toEqual({ typical: 5000, low: 2776, high: 7224 });
  });

  it("is 10 % or 1.00 below four payments, and absent when the amount varies", () => {
    const phone = amountBand(["45.00", "61.25", "45.00"])!;
    expect(phone).toEqual({ typical: 4500, low: 4050, high: 4950 });
    expect(outsideBand(phone, "61.25")).toBe(1625);
    expect(amountBand(["3.12"])).toEqual({ typical: 312, low: 212, high: 412 });
    expect(amountBand(["3.12", "3.40", "3.38", "3.55"], true)).toBeNull();
    expect(amountBand([])).toBeNull();
  });
});

describe("description matching", () => {
  it("compares descriptions as word sets: case, order, spacing, dates and filler words do not matter", () => {
    expect(tokens("Home internet plan")).toEqual(["home", "internet"]);
    expect(tokens("Internet bill — October 2026, paid")).toEqual(["internet"]);
    expect(tokens("Joe’s  DINER")).toEqual(["diner", "joes"]);
    expect(textSimilarity("Bike share monthly pass", "Bike Share Monthly Pass")).toBe(1);
    expect(textSimilarity("Unlimited bus weekend pass", "Unlimited weekend bus pass")).toBe(1);
    expect(textSimilarity("Internet bill", "Home internet plan")).toBe(0.75);
    expect(textSimilarity("Unlimited bus weekend pass", "Unlimited public transport weekend pass")).toBe(0.625);
  });

  it("keeps different payments apart", () => {
    expect(textSimilarity("Internet bill", "Phone bill")).toBe(0);
    expect(textSimilarity("Home internet", "Home hardware store")).toBeLessThan(0.6);
    expect(textSimilarity("Bill", "Monthly fee")).toBe(0);
  });
});

const NOV = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: "t",
    date: NOV(16),
    type: "expense",
    amount: "64.99",
    description: "Internet",
    merchantId: null,
    subcategoryId: null,
    incomeSourceId: null,
    fromAccountId: null,
    toAccountId: null,
    seriesId: null,
    ...over,
  };
}

function series(over: Partial<Series>): Series {
  return {
    id: 1,
    name: "Internet bill",
    kind: "expense",
    cadence: "monthly",
    amountVaries: false,
    merchantId: null,
    subcategoryId: 7,
    incomeSourceId: null,
    fromAccountId: null,
    toAccountId: null,
    keywords: [],
    ...over,
  };
}

// The internet bill as the owner logs it: no merchant, the wording drifts.
const INTERNET_WORDING = ["Internet bill", "Home internet plan", "HOME INTERNET", "internet", "Home internet plan"];
const INTERNET_HISTORY = INTERNET.map((date, i) =>
  row({ id: `i${i}`, date, description: INTERNET_WORDING[i], subcategoryId: 7, seriesId: 1 }),
);
const internet = { series: series({}), linked: INTERNET_HISTORY, excluded: [] as string[], pauses: [] as Pause[] };

// name, how the payment differs from a 64.99 "Internet" on Nov 16 in the same subcategory, strength
const MATCHES: [string, Partial<LedgerRow>, string][] = [
  ["a reworded description at the usual amount", { description: "Home internet service" }, "strong"],
  ["a reworded description on schedule at a new price", { description: "Internet", amount: "150.00" }, "strong"],
  ["a reworded description at the usual amount off schedule", { description: "home Internet", date: NOV(28) }, "strong"],
  ["a new price off schedule", { description: "Internet", amount: "150.00", date: NOV(28) }, "none"],
  ["only the subcategory, at the usual amount and on schedule", { description: "Router rental" }, "weak"],
  ["only the subcategory, off schedule", { description: "Router rental", date: NOV(28) }, "none"],
  ["another bill", { description: "Phone bill", subcategoryId: 8 }, "none"],
  ["a payment of another kind", { type: "income", incomeSourceId: 3 }, "none"],
  ["a payment already in another series", { seriesId: 2 }, "none"],
];

describe("matching a payment to a series", () => {
  it.each(MATCHES)("matches %s", (_name, over, strength) => {
    expect(matchStrength(internet, row({ subcategoryId: 7, ...over })).strength).toBe(strength);
  });

  it("never offers a payment the owner excluded from the series", () => {
    expect(matchStrength({ ...internet, excluded: ["t"] }, row({})).strength).toBe("none");
  });

  it("matches wording seen only in the series' history, not just its name", () => {
    // Three ways of writing the same weekend transit pass, bought irregularly.
    const pass = series({ id: 4, name: "Weekend transit pass", subcategoryId: null });
    const history = [
      row({ id: "w0", date: "2026-06-13", description: "Unlimited bus weekend pass", amount: "12.50", seriesId: 4 }),
      row({ id: "w1", date: "2026-07-25", description: "Unlimited weekend bus pass", amount: "12.50", seriesId: 4 }),
    ];
    const tx = row({ date: "2026-09-19", description: "Unlimited public transport weekend pass", amount: "12.50" });
    expect(textSimilarity(pass.name, tx.description)).toBeLessThan(0.6);
    expect(matchStrength({ series: pass, linked: history, excluded: [], pauses: [] }, tx).strength).toBe("strong");
    // A series with no linked payment has no amount or schedule to agree with.
    expect(matchStrength({ series: pass, linked: [], excluded: [], pauses: [] }, tx).strength).toBe("none");
  });

  it("matches income by source and a transfer by its accounts, whatever the wording", () => {
    const salary = { series: series({ id: 2, name: "Salary", kind: "income", subcategoryId: null, incomeSourceId: 3 }), linked: [], excluded: [], pauses: [] };
    expect(matchStrength(salary, row({ type: "income", incomeSourceId: 3, description: "Pay", amount: "1400.00" })).strength).toBe("strong");
    expect(matchStrength(salary, row({ type: "income", incomeSourceId: 4 })).strength).toBe("none");
    const savings = { series: series({ id: 3, name: "To savings", kind: "transfer", subcategoryId: null, toAccountId: 2 }), linked: [], excluded: [], pauses: [] };
    expect(matchStrength(savings, row({ type: "transfer", toAccountId: 2, description: "x" })).strength).toBe("strong");
    expect(matchStrength(savings, row({ type: "transfer", fromAccountId: 2, description: "x" })).strength).toBe("none");
  });

  it("matches by merchant, and by a keyword the owner added", () => {
    const gym = { series: series({ id: 5, name: "Gym", merchantId: 9, keywords: ["fitness club"], subcategoryId: null }), linked: [row({ id: "g", date: "2026-10-03", amount: "25.00", seriesId: 5 })], excluded: [], pauses: [] };
    expect(matchStrength(gym, row({ date: NOV(3), amount: "25.00", merchantId: 9, description: "Monthly" })).strength).toBe("strong");
    expect(matchStrength(gym, row({ date: NOV(3), amount: "25.00", description: "Fitness club" })).strength).toBe("strong");
  });

  it("picks the stronger match, then the closer slot, then the closer amount", () => {
    const m = (seriesId: number, strength: "strong" | "weak" | "none", slotDays: number, amountCents: number) => ({ seriesId, strength, slotDays, amountCents });
    expect(bestMatch([m(1, "weak", 0, 0), m(2, "strong", 3, 500)])?.seriesId).toBe(2);
    expect(bestMatch([m(1, "strong", 3, 0), m(2, "strong", 1, 900)])?.seriesId).toBe(2);
    expect(bestMatch([m(1, "strong", 1, 900), m(2, "strong", 1, Infinity), m(3, "strong", 1, 100)])?.seriesId).toBe(3);
    expect(bestMatch([m(1, "none", 0, 0)])).toBeNull();
  });
});

describe("proposing undeclared series", () => {
  const gymRows = GYM.map((date, i) =>
    row({ id: `g${i}`, date, amount: "25.00", description: ["Gym", "Gym membership", "gym", "GYM"][i] }),
  );

  it("groups reworded descriptions with no merchant and proposes a regular one", () => {
    const [gym, ...rest] = proposeSeries(gymRows, [], "2026-10-31");
    expect(rest).toEqual([]);
    expect(gym).toMatchObject({ key: "desc:gym", kind: "expense", transactionIds: ["g0", "g1", "g2", "g3"] });
    expect(gym.fit.cadence).toBe("monthly");
  });

  it("keeps a different amount under the same words apart", () => {
    const dayPasses = ["2026-06-20", "2026-08-01", "2026-09-12"].map((date, i) =>
      row({ id: `d${i}`, date, amount: "10.00", description: "Gym day pass" }),
    );
    const groups = proposeSeries([...gymRows, ...dayPasses], [], "2026-10-31");
    expect(groups.map((p) => p.transactionIds)).toEqual([["g0", "g1", "g2", "g3"]]);
  });

  it("proposes income by source, transfers by accounts and expenses by merchant", () => {
    const salary = SALARY.map((date, i) => row({ id: `s${i}`, date, type: "income", incomeSourceId: 3, amount: "2000.00", description: "Pay" }));
    const saving = INTERNET.map((date, i) => row({ id: `v${i}`, date, type: "transfer", toAccountId: 2, amount: "100.00", description: "x" }));
    const club = GYM.map((date, i) => row({ id: `c${i}`, date, merchantId: 9, amount: "30.00", description: `visit ${i}` }));
    expect(proposeSeries([...salary, ...saving, ...club], [], "2026-10-31").map((p) => [p.key, p.fit.cadence])).toEqual([
      ["income:3", "biweekly"],
      ["transfer:0:2", "monthly"],
      ["merchant:9", "monthly"],
    ]);
  });

  it("does not propose twice-a-week shopping, a dismissed group or one already tracked", () => {
    const shop = GROCERIES.map((date, i) => row({ id: `s${i}`, date, merchantId: 4, amount: "40.00" }));
    expect(proposeSeries(shop, [], "2026-10-31")).toEqual([]);
    // Dismissed under slightly different wording: still the same group.
    expect(proposeSeries(gymRows, ["desc:gym membership"], "2026-10-31")).toEqual([]);
    expect(proposeSeries(gymRows, ["merchant:9"], "2026-10-31")).toHaveLength(1);
    const tracked = gymRows.map((r, i) => (i === 0 ? { ...r, seriesId: 5 } : r));
    expect(proposeSeries(tracked, [], "2026-10-31")).toEqual([]);
  });

  it("reads only the last 400 days, and skips descriptions with no words", () => {
    expect(proposeSeries(gymRows, [], "2027-12-31")).toEqual([]);
    const numbers = gymRows.map((r) => ({ ...r, description: "25.00" }));
    expect(proposeSeries(numbers, [], "2026-10-31")).toEqual([]);
  });
});

describe("purity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does no I/O: pg is mocked to throw on import and the network on call", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("recurring.ts must not call the network");
    });
    expect(() => {
      proposeSeries([...INTERNET_HISTORY.map((r) => ({ ...r, seriesId: null }))], [], "2026-10-31");
      matchStrength(internet, row({}));
      occurrences({ cadence: "monthly", payments: paid(INTERNET), pauses: [], skips: [], today: "2026-10-31" });
    }).not.toThrow();
  });
});
