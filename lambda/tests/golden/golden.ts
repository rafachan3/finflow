import { readdirSync, readFileSync } from "node:fs";

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
  merchant?: boolean;
  date?: boolean;
  note?: boolean;
  /** Whole words the note must contain, case-insensitive (e.g. a typo's correction). */
  noteHas?: string[];
  /** Whole words the note must not contain (a typo left in, a repeated fact). */
  noteLacks?: string[];
  /** A copy-edit adds little; more words than this means facts were added. */
  noteMaxWords?: number;
  funder?: string;
  /** Each line's bucket, in order. Only meaningful with `rules`. */
  buckets?: ("needs" | "wants")[];
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
  notes?: unknown;
  funded_by?: unknown;
  items?: { amount?: unknown; description?: unknown; bucket?: unknown }[];
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

/** An edit records one extraction; every other case records `{ events }`. */
export function recordedEvents(g: Golden): RawEvent[] {
  if (g.input.kind === "edit") return [g.recorded as RawEvent];
  return (g.recorded as { events?: RawEvent[] }).events ?? [];
}

function present(v: unknown): boolean {
  return typeof v === "string" && v.trim() !== "";
}

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
    if (got.type === "expense" && items.length === want.lines && items.length > 0) {
      const sum = items.reduce((s, item) => s + cents(item.amount), 0);
      if (sum !== cents(got.amount)) {
        out.push(`${at}: lines sum ${(sum / 100).toFixed(2)} != ${String(got.amount)}`);
      }
    }
  });
  return out;
}
