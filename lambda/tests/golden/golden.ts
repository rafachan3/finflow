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
  merchant?: boolean;
  date?: boolean;
  note?: boolean;
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
