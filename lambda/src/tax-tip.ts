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

/** Order discounts as the model gives them. Receipts print them negative; here a discount is what comes off. */
export function discountsOf(raw: unknown): Money[] {
  return Array.isArray(raw) ? raw.map((d) => String(d).replace(/^-/, "")) : [];
}

const total = (cents: number[]) => cents.reduce((a, b) => a + b, 0);

/**
 * Each line's amount paid: its price, less its share of the order discounts,
 * plus its share of the taxes and of the tip. Discounts come off every line
 * by price. Taxes then go to the taxable lines, or to every line when none
 * is marked, and the tip to every line, both weighted by discounted price.
 * The result sums to prices - discounts + taxes + tip exactly. Null when an
 * amount is not two-decimal or the discounts exceed the prices.
 */
export function lineAmounts(
  lines: PricedLine[],
  taxes: Money[],
  tip: Money | null,
  discounts: Money[] = [],
): Money[] | null {
  const prices = lines.map((l) => parseCents(l.price));
  const tax = taxes.map(parseCents);
  const off = discounts.map(parseCents);
  const tipCents = tip === null ? 0 : parseCents(tip);
  if (tipCents === null || [...prices, ...tax, ...off].includes(null)) return null;
  const p = prices as number[];
  const offShares = allocate(total(off as number[]), p);
  const net = p.map((c, i) => c - offShares[i]);
  if (net.some((c) => c < 0)) return null;
  const flagged = net.map((c, i) => (lines[i].taxable ? c : 0));
  const taxShares = allocate(total(tax as number[]), flagged.some((c) => c > 0) ? flagged : net);
  const tipShares = allocate(tipCents, net);
  return net.map((c, i) => money(c + taxShares[i] + tipShares[i]));
}

/** An event as the funder rule sees it: its header, funder and line amounts paid. */
export type FundedEvent = {
  amount: Money;
  funded_by: string | null;
  items: { amount: Money }[];
  /** The header the model gave, set only when this rule replaced it. */
  stated_amount?: Money;
};

/**
 * The funder belongs to a whole transaction, so a message that mixes funders
 * gives one event per funder. A model can still put the message's total on
 * one of them (#96): a header of 126.00 over lines of 120.00, the 6.00 being
 * a sibling paid by someone else. When an expense header exceeds its own
 * lines by exactly the line sums of all the other expenses in the message
 * with a different funder, the header is the whole message's total: the
 * event's own line sum replaces it, and `stated_amount` keeps the model's
 * header so the card warns. Any other mismatch stands, and the line-sum check
 * refuses the card. Same-funder siblings never count (#97).
 */
export function withoutLeakedTotals<T extends FundedEvent>(events: T[]): T[] {
  const sums = events.map((e) => {
    const cents = e.items.map((i) => parseCents(i.amount));
    // Income and transfers have no lines, so they never count or change.
    return cents.length > 0 && !cents.includes(null) ? total(cents as number[]) : null;
  });
  return events.map((e, i) => {
    const header = parseCents(e.amount);
    const own = sums[i];
    if (own === null || header === null || header <= own) return e;
    const others = total(sums.filter((s, j): s is number => s !== null && events[j].funded_by !== e.funded_by));
    return header - own === others ? { ...e, amount: money(own), stated_amount: e.amount } : e;
  });
}

/** A card's money as an Edit sees it; `price` is absent on cards stored before 2026-11-07. */
export type EditParts = {
  amount: Money;
  taxes?: Money[];
  tip?: Money | null;
  discounts?: Money[];
  items: { amount: Money; price?: Money; taxable?: boolean }[];
};

/**
 * An Edit's header. When the model left the total alone, the sum of the
 * recomputed lines replaces it only for a correction to the tip, a whole-order
 * discount or a line's price: the taxes and the number of lines are
 * unchanged, and no tip or discount is removed. Then the model does no
 * arithmetic. Any other difference (a dropped tax, a lost line, tip or
 * discount) keeps the stored total, and the line-sum check fails it
 * visibly. A total the model changed stands. A card stored before prices
 * keeps its total: its line amounts already hold the tax and tip, so a
 * recomputed sum would count a tip twice.
 */
export function editedTotal(patched: EditParts, current: EditParts): Money {
  const cents = patched.items.map((i) => parseCents(i.amount));
  const same = parseCents(patched.amount) !== null && parseCents(patched.amount) === parseCents(current.amount);
  const priced = current.items.every((i) => i.price !== undefined);
  const tip = (p: EditParts) => p.tip ?? null;
  const off = (p: EditParts) => p.discounts ?? [];
  const prices = (p: EditParts) => JSON.stringify(p.items.map((i) => [i.price, i.taxable ?? false]));
  const sameShape =
    JSON.stringify(patched.taxes ?? []) === JSON.stringify(current.taxes ?? []) &&
    patched.items.length === current.items.length &&
    (tip(patched) !== null || tip(current) === null) &&
    off(patched).length >= off(current).length;
  const tipOrPrice =
    tip(patched) !== tip(current) ||
    prices(patched) !== prices(current) ||
    JSON.stringify(off(patched)) !== JSON.stringify(off(current));
  if (!same || !priced || !sameShape || !tipOrPrice || cents.length === 0 || cents.includes(null)) {
    return patched.amount;
  }
  return money((cents as number[]).reduce((a, b) => a + b, 0));
}
