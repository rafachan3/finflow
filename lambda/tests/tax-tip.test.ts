import { describe, expect, it } from "vitest";
import { parseCents } from "../src/extraction.js";
import { allocate, editedTotal, lineAmounts, type PricedLine } from "../src/tax-tip.js";

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
});

describe("editedTotal", () => {
  it("follows the recomputed lines when the correction left the total alone", () => {
    expect(editedTotal("33.24", "33.24", ["22.23", "12.51"])).toBe("34.74");
  });

  it("keeps a total the correction changed, for the line-sum check to judge", () => {
    expect(editedTotal("14.50", "14.00", ["14.50"])).toBe("14.50");
    expect(editedTotal("39.24", "33.24", ["22.23", "12.51"])).toBe("39.24");
  });

  it("keeps the total when there are no lines or a line is not two-decimal", () => {
    expect(editedTotal("50.00", "50.00", [])).toBe("50.00");
    expect(editedTotal("50.00", "50.00", ["5"])).toBe("50.00");
  });
});
