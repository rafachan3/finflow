import { describe, expect, it } from "vitest";
import { parseCents } from "../src/extraction.js";
import {
  allocate,
  discountsOf,
  editedTotal,
  lineAmounts,
  withoutLeakedTotals,
  type FundedEvent,
  type PricedLine,
} from "../src/tax-tip.js";

/** Deterministic pseudo-random cases (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cents = (m: string) => parseCents(m)!;
const money = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocate", () => {
  it("always sums exactly, is never negative, and stays within a cent of the exact share", () => {
    const next = rng(42);
    const bad: unknown[] = [];
    for (let run = 0; run < 1000; run++) {
      const n = 1 + Math.floor(next() * 8);
      const weights = Array.from({ length: n }, () => (next() < 0.15 ? 0 : Math.floor(next() * 50_000)));
      const total = Math.floor(next() * 20_000);
      const shares = allocate(total, weights);
      const w = weights.some((x) => x > 0) ? weights : weights.map(() => 1);
      const off = shares.some((s, i) => s < 0 || Math.abs(s - (total * w[i]) / sum(w)) >= 1);
      if (sum(shares) !== total || off) bad.push({ total, weights, shares });
    }
    expect(bad).toEqual([]);
  });

  it("gives a larger weight at least the share of a smaller one", () => {
    const next = rng(7);
    const bad: unknown[] = [];
    for (let run = 0; run < 500; run++) {
      const weights = Array.from({ length: 5 }, () => Math.floor(next() * 3000));
      const shares = allocate(Math.floor(next() * 5000), weights);
      const inverted = weights.some((wi, i) => weights.some((wj, j) => wi > wj && shares[i] < shares[j]));
      if (inverted) bad.push({ weights, shares });
    }
    expect(bad).toEqual([]);
  });

  it("gives a tied leftover cent to the earlier line, and splits evenly when every weight is zero", () => {
    expect(allocate(1, [100, 100])).toEqual([1, 0]);
    expect(allocate(5, [0, 0])).toEqual([3, 2]);
    expect(allocate(0, [300, 100])).toEqual([0, 0]);
  });

  it("stays exact on totals past 2^53 when multiplied out", () => {
    const shares = allocate(999_999_999_999, [999_999_999_999, 1]);
    expect(sum(shares)).toBe(999_999_999_999);
  });
});

describe("lineAmounts", () => {
  it("a Quebec receipt puts GST and QST only on the line it marks taxable", () => {
    // Synthetic: a zero-rated grocery line and a taxed one (GQ code).
    const lines: PricedLine[] = [
      { price: "9.99", taxable: false },
      { price: "6.99", taxable: true },
    ];
    expect(lineAmounts(lines, ["0.35", "0.70"], null)).toEqual(["9.99", "8.04"]);
  });

  it("spreads the taxes over every line when the receipt marks none, and the tip by price", () => {
    const diner: PricedLine[] = [
      { price: "16.00", taxable: false },
      { price: "9.00", taxable: false },
    ];
    // 28.74 printed total plus a 4.50 tip below it.
    expect(lineAmounts(diner, ["1.25", "2.49"], "4.50")).toEqual(["21.27", "11.97"]);
    expect(lineAmounts(diner, ["1.25", "2.49"], "6.00")).toEqual(["22.23", "12.51"]);
  });

  it("puts the tip on untaxed lines too, by price", () => {
    const lines: PricedLine[] = [
      { price: "30.00", taxable: true },
      { price: "10.00", taxable: false },
    ];
    expect(lineAmounts(lines, ["4.00"], "8.00")).toEqual(["40.00", "12.00"]);
  });

  it("keeps the prices when there is no tax and no tip", () => {
    expect(lineAmounts([{ price: "3.00", taxable: false }], [], null)).toEqual(["3.00"]);
  });

  it("returns null when a price, tax or tip is not two-decimal", () => {
    const line = { price: "3.00", taxable: true };
    expect(lineAmounts([{ price: "3", taxable: true }], [], null)).toBeNull();
    expect(lineAmounts([line], ["0.4"], null)).toBeNull();
    expect(lineAmounts([line], [], "-1.00")).toBeNull();
  });

  it("always sums to prices + taxes + tip, never below a line's price, with the tip proportional", () => {
    const next = rng(2026);
    const bad: unknown[] = [];
    for (let run = 0; run < 1000; run++) {
      const n = 1 + Math.floor(next() * 6);
      const lines = Array.from({ length: n }, () => ({
        price: money(Math.floor(next() * 10_000)),
        taxable: next() < 0.5,
      }));
      const taxes = Array.from({ length: Math.floor(next() * 3) }, () => money(Math.floor(next() * 2000)));
      const tip = next() < 0.5 ? null : money(Math.floor(next() * 3000));
      const out = lineAmounts(lines, taxes, tip)!.map(cents);
      const prices = lines.map((l) => cents(l.price));
      const exactSum = sum(out) === sum(prices) + sum(taxes.map(cents)) + (tip ? cents(tip) : 0);
      const belowPrice = out.some((c, i) => c < prices[i]);
      // With no tax, each line's extra is its tip share: within a cent of tip * price / total.
      const noTax = lineAmounts(lines, [], tip)!.map(cents);
      const tipOff =
        tip !== null &&
        sum(prices) > 0 &&
        noTax.some((c, i) => Math.abs(c - prices[i] - (cents(tip) * prices[i]) / sum(prices)) >= 1);
      if (!exactSum || belowPrice || tipOff) bad.push({ lines, taxes, tip, out });
    }
    expect(bad).toEqual([]);
  });
  it("takes a whole-order discount off every line by price, then shares the taxes by discounted price", () => {
    // Synthetic: 20.00 of goods, a 5.00 coupon, GST and QST on the 15.00 left, no tax codes.
    const hardware: PricedLine[] = [
      { price: "12.00", taxable: false },
      { price: "8.00", taxable: false },
    ];
    expect(lineAmounts(hardware, ["0.75", "1.50"], null, ["5.00"])).toEqual(["10.35", "6.90"]);
    // A coupon on a Quebec grocery order: only the GQ line carries the taxes, on its discounted price.
    const grocery: PricedLine[] = [
      { price: "9.99", taxable: false },
      { price: "6.99", taxable: true },
    ];
    expect(lineAmounts(grocery, ["0.31", "0.62"], null, ["2.00"])).toEqual(["8.81", "7.10"]);
  });

  it("reads a discount printed negative as what comes off", () => {
    expect(discountsOf(["-5.00", "1.50"])).toEqual(["5.00", "1.50"]);
    expect(discountsOf(undefined)).toEqual([]);
  });

  it("returns null when a discount is not two-decimal or is more than the prices", () => {
    const line = { price: "3.00", taxable: true };
    expect(lineAmounts([line], [], null, ["1.5"])).toBeNull();
    expect(lineAmounts([line], [], null, ["3.01"])).toBeNull();
    expect(lineAmounts([line], [], null, ["3.00"])).toEqual(["0.00"]);
  });

  it("always sums to prices - discounts + taxes + tip, takes each line's discount by price, and never below zero", () => {
    const next = rng(118);
    const bad: unknown[] = [];
    for (let run = 0; run < 1000; run++) {
      const n = 1 + Math.floor(next() * 6);
      const lines = Array.from({ length: n }, () => ({
        price: money(Math.floor(next() * 10_000)),
        taxable: next() < 0.5,
      }));
      const prices = lines.map((l) => cents(l.price));
      const discounts = Array.from({ length: Math.floor(next() * 3) }, () =>
        money(Math.floor((next() * sum(prices)) / 2)),
      );
      const taxes = Array.from({ length: Math.floor(next() * 3) }, () => money(Math.floor(next() * 2000)));
      const tip = next() < 0.5 ? null : money(Math.floor(next() * 3000));
      const out = lineAmounts(lines, taxes, tip, discounts)!.map(cents);
      const off = sum(discounts.map(cents));
      const exactSum = sum(out) === sum(prices) - off + sum(taxes.map(cents)) + (tip ? cents(tip) : 0);
      const negative = out.some((c) => c < 0);
      // With no tax or tip, each line's reduction is within a cent of discount * price / total.
      const bare = lineAmounts(lines, [], null, discounts)!.map(cents);
      const offShare =
        sum(prices) > 0 && bare.some((c, i) => Math.abs(prices[i] - c - (off * prices[i]) / sum(prices)) >= 1);
      if (!exactSum || negative || offShare) bad.push({ lines, discounts, taxes, tip, out });
    }
    expect(bad).toEqual([]);
  });
});

describe("editedTotal", () => {
  // The diner card as stored, and the same card after a tip correction to 6.00.
  const before = {
    amount: "33.24",
    taxes: ["1.25", "2.49"],
    tip: "4.50",
    items: [
      { price: "16.00", taxable: false, amount: "21.27" },
      { price: "9.00", taxable: false, amount: "11.97" },
    ],
  };
  const newTip = (amount: string) => ({
    ...before,
    amount,
    tip: "6.00",
    items: [
      { price: "16.00", taxable: false, amount: "22.23" },
      { price: "9.00", taxable: false, amount: "12.51" },
    ],
  });

  it("follows the recomputed lines when the correction left the total alone", () => {
    expect(editedTotal(newTip("33.24"), before)).toBe("34.74");
  });

  it("keeps a total the correction changed, for the line-sum check to judge", () => {
    expect(editedTotal(newTip("39.24"), before)).toBe("39.24");
    const lunch = { amount: "14.00", items: [{ price: "14.00", taxable: false, amount: "14.00" }] };
    expect(editedTotal({ ...lunch, amount: "14.50", items: [{ ...lunch.items[0], price: "14.50", amount: "14.50" }] }, lunch)).toBe("14.50");
  });

  it("keeps the total when there are no lines or a line is not two-decimal", () => {
    expect(editedTotal({ ...before, tip: "6.00", items: [] }, before)).toBe("33.24");
    expect(editedTotal({ ...newTip("33.24"), items: [{ price: "16.00", taxable: false, amount: "5" }] }, before)).toBe("33.24");
  });

  it("follows the recomputed lines when a correction changes a line's price and leaves the total alone", () => {
    // The salad was 10.00, not 9.00: lineAmounts gives 21.07 and 13.17.
    const items = [
      { price: "16.00", taxable: false, amount: "21.07" },
      { price: "10.00", taxable: false, amount: "13.17" },
    ];
    expect(editedTotal({ ...before, items }, before)).toBe("34.24");
  });

  it("keeps the stored total when the model drops or changes a tax, removes the tip, or changes nothing", () => {
    const quebec = {
      amount: "24.52",
      taxes: ["0.35", "0.70"],
      tip: null,
      items: [
        { price: "9.99", taxable: false, amount: "9.99" },
        { price: "6.49", taxable: false, amount: "6.49" },
        { price: "6.99", taxable: true, amount: "8.04" },
      ],
    };
    const droppedTax = { ...quebec, taxes: ["0.35"], items: [quebec.items[0], quebec.items[1], { ...quebec.items[2], amount: "7.34" }] };
    expect(editedTotal(droppedTax, quebec)).toBe("24.52");
    const noTip = { ...before, tip: null, items: before.items.map((i) => ({ ...i, amount: "0.00" })) };
    expect(editedTotal(noTip, before)).toBe("33.24");
    expect(editedTotal({ ...before, items: [before.items[0]] }, before)).toBe("33.24");
    expect(editedTotal(before, before)).toBe("33.24");
  });

  it("follows the recomputed lines for a corrected or added discount, and keeps the total when one is dropped", () => {
    // The hardware order: 12.00 and 8.00, a 5.00 coupon, GST and QST on the rest.
    const coupon = {
      amount: "17.25",
      taxes: ["0.75", "1.50"],
      tip: null,
      discounts: ["5.00"],
      items: [
        { price: "12.00", taxable: false, amount: "10.35" },
        { price: "8.00", taxable: false, amount: "6.90" },
      ],
    };
    // The coupon was 4.00: lineAmounts gives 10.95 and 7.30.
    const fourOff = { ...coupon, discounts: ["4.00"], items: [{ ...coupon.items[0], amount: "10.95" }, { ...coupon.items[1], amount: "7.30" }] };
    expect(editedTotal(fourOff, coupon)).toBe("18.25");
    const dropped = { ...coupon, discounts: [], items: [{ ...coupon.items[0], amount: "13.35" }, { ...coupon.items[1], amount: "8.90" }] };
    expect(editedTotal({ ...coupon, amount: "22.25" }, { ...dropped, amount: "22.25" })).toBe("17.25");
    expect(editedTotal(dropped, coupon)).toBe("17.25");
  });

  it("keeps the stored total on a card stored before prices, whose lines already hold its tax and tip", () => {
    const old = { amount: "50.00", items: [{ amount: "50.00" }] };
    const patched = { amount: "50.00", taxes: [], tip: "8.00", items: [{ price: "50.00", taxable: false, amount: "58.00" }] };
    expect(editedTotal(patched, old)).toBe("50.00");
  });
});

describe("withoutLeakedTotals", () => {
  const expense = (amount: string, funded_by: string, ...lines: string[]): FundedEvent & { type: string } => ({
    type: "expense",
    amount,
    funded_by,
    items: lines.map((l) => ({ amount: l })),
  });
  const headers = (events: FundedEvent[]) => withoutLeakedTotals(events).map((e) => e.amount);

  it("takes another funder's lines out of a header that holds the whole message, keeping order", () => {
    const events = [expense("126.00", "family", "20.00", "100.00"), expense("6.00", "self", "4.00", "2.00")];
    const out = withoutLeakedTotals(events);
    expect(out.map((e) => e.amount)).toEqual(["120.00", "6.00"]);
    expect(out.map((e) => e.stated_amount)).toEqual(["126.00", undefined]);
  });

  it("fixes every header when each carries the message total", () => {
    const events = [expense("126.00", "family", "20.00", "100.00"), expense("126.00", "self", "4.00", "2.00")];
    expect(headers(events)).toEqual(["120.00", "6.00"]);
  });

  it("leaves a single funder alone, even a mismatched header", () => {
    expect(headers([expense("126.00", "family", "20.00", "100.00")])).toEqual(["126.00"]);
    const same = [expense("126.00", "family", "20.00", "100.00"), expense("6.00", "family", "4.00", "2.00")];
    const out = withoutLeakedTotals(same);
    expect(out.map((e) => e.amount)).toEqual(["126.00", "6.00"]);
    expect(out[0]).toBe(same[0]);
    expect(out[0].stated_amount).toBeUndefined();
  });

  it("with three funders, takes out all the other funders' lines and refuses a partial leak", () => {
    const sibs = [expense("5.00", "family", "5.00"), expense("3.00", "friend", "3.00")];
    expect(headers([expense("18.00", "self", "10.00"), ...sibs])).toEqual(["10.00", "5.00", "3.00"]);
    expect(headers([expense("13.00", "self", "10.00"), ...sibs])).toEqual(["13.00", "5.00", "3.00"]);
    expect(headers([expense("15.00", "self", "10.00"), ...sibs])).toEqual(["15.00", "5.00", "3.00"]);
  });

  it("keeps a header whose gap matches no other funder's lines, so the line-sum check refuses it", () => {
    const sib = expense("6.00", "self", "4.00", "2.00");
    expect(headers([expense("125.00", "family", "20.00", "100.00"), sib])).toEqual(["125.00", "6.00"]);
    expect(headers([expense("110.00", "family", "20.00", "100.00"), sib])).toEqual(["110.00", "6.00"]);
  });

  it("keeps an event's own tip, tax and discount, which are already in its line amounts", () => {
    const tipped = lineAmounts([{ price: "20.00", taxable: false }], [], "2.00") as string[];
    const sib = expense("4.00", "self", "4.00");
    expect(headers([expense("26.00", "family", ...tipped), sib])).toEqual(["22.00", "4.00"]);
    const discounted = lineAmounts([{ price: "20.00", taxable: false }], [], null, ["2.00"]) as string[];
    expect(headers([expense("22.00", "family", ...discounted), sib])).toEqual(["18.00", "4.00"]);
  });

  it("does not take out a sibling's pre-tax price when its lines hold tax", () => {
    const taxed = lineAmounts([{ price: "4.00", taxable: true }], ["0.60"], null) as string[];
    const events = [expense("124.00", "family", "20.00", "100.00"), expense("4.60", "self", ...taxed)];
    expect(headers(events)).toEqual(["124.00", "4.60"]);
  });

  it("never counts or changes income, which has no lines", () => {
    const income = { type: "income", amount: "120.00", funded_by: null, items: [] };
    expect(headers([expense("126.00", "family", "20.00", "100.00"), income])).toEqual(["126.00", "120.00"]);
  });
});
