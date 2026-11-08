import { readdirSync, readFileSync } from "node:fs";
import { canonicalTags, stripCategoryPrefix } from "../../src/extraction.js";
import { discountsOf, editedTotal, lineAmounts, type EditParts } from "../../src/tax-tip.js";

/**
 * One owner message per file: the input, the shape Gemini's answer must have,
 * and a recorded answer. Journeys replay the recording; the eval checks live
 * Gemini against the same expectation.
 */
export type GoldenInput =
  | { kind: "text"; text: string }
  | { kind: "photo" | "voice"; caption: string; media: string }
  | { kind: "edit"; base: string; correction: string };

export type ExpectedEvent = {
  type: "expense" | "income" | "transfer";
  lines: number;
  /** The header amount, when the case is about what was paid (a tip, a correction). */
  amount?: string;
  /** Each line's amount paid, in order, when the case is about how tax and tip are shared. */
  amounts?: string[];
  merchant?: boolean;
  date?: boolean;
  /** The exact date, when the case is about how a printed date is read. */
  dateIs?: string;
  /** The exact venue; null when the place is none of the listed venues. */
  venue?: string | null;
  note?: boolean;
  /** Whole words the note must contain, case-insensitive (e.g. a typo's correction). */
  noteHas?: string[];
  /** Whole words the note must not contain (a typo left in, a repeated fact). */
  noteLacks?: string[];
  /** A copy-edit adds little; more words than this means facts were added. */
  noteMaxWords?: number;
  funder?: string;
  /** A transfer's accounts; null is chequing. */
  fromAccount?: string | null;
  toAccount?: string | null;
  /** Each line's bucket, in order. Only meaningful with `rules`. */
  buckets?: ("needs" | "wants")[];
  /** Each line's "category / subcategory[ / item type]", in order, as the card prints it. */
  classes?: string[];
  /** The whole-transaction tags, as a set. */
  tags?: string[];
  /** Each line's own tags, in line order, as sets. */
  lineTags?: string[][];
};

export type Golden = {
  file: string;
  name: string;
  input: GoldenInput;
  expect: { events: ExpectedEvent[] };
  /** A ruleset file in this directory, sent where production sends the owner's rules. */
  rules?: string;
  recorded: unknown;
  /** Hash of the request whose answer is `recorded` (eval/harness.ts requestHash). */
  request_sha256?: string;
};

export type RawEvent = {
  type?: unknown;
  amount?: unknown;
  date?: unknown;
  merchant?: unknown;
  venue?: unknown;
  notes?: unknown;
  funded_by?: unknown;
  from_account?: unknown;
  to_account?: unknown;
  tags?: unknown;
  discounts?: unknown;
  taxes?: unknown;
  tip?: unknown;
  items?: {
    amount?: unknown;
    price?: unknown;
    taxable?: unknown;
    description?: unknown;
    bucket?: unknown;
    tags?: unknown;
    category?: unknown;
    subcategory?: unknown;
    item_type?: unknown;
  }[];
};

const DIR = new URL("./", import.meta.url);

export function golden(file: string): Golden {
  const raw = JSON.parse(readFileSync(new URL(`${file}.json`, DIR), "utf8"));
  return { file, ...raw } as Golden;
}

export function allGoldens(): Golden[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => golden(f.slice(0, -".json".length)));
}

/** The needs/wants rules a case runs with; empty means the bot's no-rules fallback. */
export function bucketRules(g: Pick<Golden, "rules">): string {
  return g.rules ? readFileSync(new URL(g.rules, DIR), "utf8") : "";
}

/**
 * A raw answer as the bot reads it: each line's amount from its price, the
 * order discounts, the taxes and the tip (tax-tip.ts). A recording from before prices already
 * holds line amounts and is left as it is.
 */
function shared(e: RawEvent): RawEvent {
  const items = Array.isArray(e.items) ? e.items : [];
  if (!items.some((i) => i.price !== undefined)) return e;
  const amounts = lineAmounts(
    items.map((i) => ({ price: String(i.price ?? i.amount ?? ""), taxable: i.taxable === true })),
    names(e.taxes),
    e.tip === null || e.tip === undefined ? null : String(e.tip),
    discountsOf(e.discounts),
  );
  return amounts ? { ...e, items: items.map((i, j) => ({ ...i, amount: amounts[j] })) } : e;
}

/** An answer's money as patchExtraction sees it: asExtraction reads a line with no price as priced at its amount. */
function editParts(e: RawEvent): EditParts {
  return {
    amount: String(e.amount ?? ""),
    taxes: names(e.taxes),
    tip: e.tip === null || e.tip === undefined || e.tip === "" ? null : String(e.tip),
    discounts: discountsOf(e.discounts),
    items: (e.items ?? []).map((i) => ({
      amount: String(i.amount ?? ""),
      price: String(i.price ?? i.amount ?? ""),
      taxable: i.taxable === true,
    })),
  };
}

/** An edit records one extraction; every other case records `{ events }`. Judged as the bot reads them. */
export function recordedEvents(g: Golden): RawEvent[] {
  if (g.input.kind === "edit") {
    const e = shared(g.recorded as RawEvent);
    if (e.type !== "expense") return [e];
    // The total patchExtraction keeps, against the base case's answer.
    const base = recordedEvents(golden(g.input.base))[0] ?? {};
    return [{ ...e, amount: editedTotal(editParts(e), editParts(base)) }];
  }
  return ((g.recorded as { events?: RawEvent[] }).events ?? []).map(shared);
}

function present(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

function names(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

const tagSet = (tags: string[]) => `[${[...tags].sort().join(", ")}]`;

function cents(v: unknown): number {
  return Math.round(Number(v) * 100);
}

/** Every way `events` differs from the expected shape; empty when it matches. */
export function mismatches(events: RawEvent[], expected: ExpectedEvent[]): string[] {
  if (events.length !== expected.length) {
    return [`expected ${expected.length} events, got ${events.length}`];
  }
  const out: string[] = [];
  expected.forEach((want, i) => {
    const got = events[i];
    const at = `event ${i}`;
    const items = Array.isArray(got.items) ? got.items : [];
    if (got.type !== want.type) out.push(`${at}: type ${String(got.type)} != ${want.type}`);
    if (items.length !== want.lines) out.push(`${at}: ${items.length} lines != ${want.lines}`);
    if (want.amount !== undefined && got.amount !== want.amount) {
      out.push(`${at}: amount ${String(got.amount)} != ${want.amount}`);
    }
    const amounts = items.map((item) => String(item.amount)).join(" + ");
    if (want.amounts !== undefined && amounts !== want.amounts.join(" + ")) {
      out.push(`${at}: line amounts ${amounts} != ${want.amounts.join(" + ")}`);
    }
    const flags = [
      ["merchant", want.merchant, got.merchant],
      ["date", want.date, got.date],
      ["note", want.note, got.notes],
    ] as const;
    for (const [field, wanted, value] of flags) {
      if (wanted !== undefined && present(value) !== wanted) {
        out.push(`${at}: ${field} ${wanted ? "missing" : "unexpected"}`);
      }
    }
    if (want.dateIs !== undefined && got.date !== want.dateIs) {
      out.push(`${at}: date ${String(got.date)} != ${want.dateIs}`);
    }
    if (want.venue !== undefined && (got.venue ?? null) !== want.venue) {
      out.push(`${at}: venue ${String(got.venue ?? null)} != ${String(want.venue)}`);
    }
    const note = typeof got.notes === "string" ? got.notes.replace(/\u2019/g, "'") : "";
    // Golden words are plain letters and apostrophes, so no escaping.
    const hasWord = (w: string) => new RegExp(`(^|[^\\w'])${w}($|[^\\w'])`, "i").test(note);
    for (const w of want.noteHas ?? []) if (!hasWord(w)) out.push(`${at}: note lacks "${w}"`);
    for (const w of want.noteLacks ?? []) if (hasWord(w)) out.push(`${at}: note has "${w}"`);
    const words = note.split(/\s+/).filter(Boolean).length;
    if (want.noteMaxWords !== undefined && words > want.noteMaxWords) {
      out.push(`${at}: note has ${words} words > ${want.noteMaxWords}`);
    }
    if (want.funder !== undefined && got.funded_by !== want.funder) {
      out.push(`${at}: funder ${String(got.funded_by)} != ${want.funder}`);
    }
    // A recording from before from_account has none: read it as null (chequing).
    const accounts = [
      ["from account", want.fromAccount, got.from_account ?? null],
      ["to account", want.toAccount, got.to_account ?? null],
    ] as const;
    for (const [field, wanted, value] of accounts) {
      if (wanted !== undefined && value !== wanted) {
        out.push(`${at}: ${field} ${String(value)} != ${String(wanted)}`);
      }
    }
    if (want.buckets !== undefined && items.length === want.lines) {
      want.buckets.forEach((bucket, j) => {
        const line = items[j];
        if (line.bucket !== bucket) {
          out.push(
            `${at}: line ${j} (${String(line.description)}) bucket ${String(line.bucket)} != ${bucket}`,
          );
        }
      });
    }
    if (want.classes !== undefined && items.length === want.lines) {
      want.classes.forEach((wanted, j) => {
        const line = items[j];
        // As stored: the model often repeats "Category / " in subcategory and item_type.
        const category = String(line.category);
        const type = line.item_type ? ` / ${stripCategoryPrefix(category, String(line.item_type))}` : "";
        const printed = `${category} / ${stripCategoryPrefix(category, String(line.subcategory))}${type}`;
        if (printed !== wanted) {
          out.push(`${at}: line ${j} (${String(line.description)}) ${printed} != ${wanted}`);
        }
      });
    }
    // Judged as stored: after a tag on every line has moved to the header.
    const tags = canonicalTags(names(got.tags), items.map((item) => names(item.tags)));
    if (want.tags !== undefined && tagSet(tags.tags) !== tagSet(want.tags)) {
      out.push(`${at}: tags ${tagSet(tags.tags)} != ${tagSet(want.tags)}`);
    }
    if (want.lineTags !== undefined && items.length === want.lines) {
      want.lineTags.forEach((wanted, j) => {
        if (tagSet(tags.lineTags[j]) !== tagSet(wanted)) {
          out.push(`${at}: line ${j} tags ${tagSet(tags.lineTags[j])} != ${tagSet(wanted)}`);
        }
      });
    }
    if (got.type === "expense" && items.length === want.lines && items.length > 0) {
      const sum = items.reduce((s, item) => s + cents(item.amount), 0);
      if (sum !== cents(got.amount)) {
        out.push(`${at}: lines sum ${(sum / 100).toFixed(2)} != ${String(got.amount)}`);
      }
    }
  });
  return out;
}
