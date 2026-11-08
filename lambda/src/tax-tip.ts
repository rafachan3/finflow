import { parseCents, type Money } from "./extraction.js";

/** A receipt line as Gemini reads it: its pre-tax price and whether the receipt marks it as taxed. */
export type PricedLine = { price: Money; taxable: boolean };

function money(cents: number): Money {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/**
 * Splits `total` cents by `weights` with largest remainder: every share is
 * floored, then the leftover cents go one each to the largest remainders
 * (ties: larger weight, then earlier). The shares sum to `total` exactly.
 * All-zero weights split evenly. BigInt keeps numeric(12,2) totals exact.
 */
export function allocate(total: number, weights: number[]): number[] {
  const w = weights.some((x) => x > 0) ? weights.map(BigInt) : weights.map(() => 1n);
  const sum = w.reduce((a, b) => a + b, 0n);
  const t = BigInt(total);
  const shares = w.map((x) => (t * x) / sum);
  const rems = w.map((x) => (t * x) % sum);
  const cmp = (a: bigint, b: bigint) => (a > b ? -1 : a < b ? 1 : 0);
  const order = w.map((_, i) => i).sort((a, b) => cmp(rems[a], rems[b]) || cmp(w[a], w[b]) || a - b);
  let left = t - shares.reduce((a, b) => a + b, 0n);
  for (const i of order) {
    if (left <= 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares.map(Number);
}

/**
 * Each line's amount paid: its price, plus its share of the taxes, plus its
 * share of the tip. Taxes go to the taxable lines, or to every line when
 * none is marked. The tip goes to every line. Both are weighted by price.
 * The result sums to prices + taxes + tip exactly. Null when an amount is not
 * two-decimal.
 */
export function lineAmounts(lines: PricedLine[], taxes: Money[], tip: Money | null): Money[] | null {
  const prices = lines.map((l) => parseCents(l.price));
  const tax = taxes.map(parseCents);
  const tipCents = tip === null ? 0 : parseCents(tip);
  if (tipCents === null || prices.includes(null) || tax.includes(null)) return null;
  const p = prices as number[];
  const flagged = p.map((c, i) => (lines[i].taxable ? c : 0));
  const taxShares = allocate(
    (tax as number[]).reduce((a, b) => a + b, 0),
    flagged.some((c) => c > 0) ? flagged : p,
  );
  const tipShares = allocate(tipCents, p);
  return p.map((c, i) => money(c + taxShares[i] + tipShares[i]));
}

/**
 * An Edit's header. A correction that leaves the total alone (a new tip, tax
 * or price) gets the sum of its recomputed lines, so the model does no
 * arithmetic. A total the correction changed stands, and the line-sum check
 * judges it.
 */
export function editedTotal(patched: Money, current: Money, lines: Money[]): Money {
  const cents = lines.map(parseCents);
  const same = parseCents(patched) !== null && parseCents(patched) === parseCents(current);
  if (!same || cents.length === 0 || cents.includes(null)) return patched;
  return money((cents as number[]).reduce((a, b) => a + b, 0));
}
