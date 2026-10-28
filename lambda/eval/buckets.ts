// Pure parts of the needs/wants accuracy check (`npm run eval:buckets`).
// The CLI that reads the database and calls Gemini is buckets-cli.ts.
import { parseCents, type Bucket, type Extraction } from "../src/extraction.js";

export type TruthLine = {
  description: string;
  amount: string;
  category: string;
  subcategory: string;
  bucket: Bucket;
};

/** An expense whose buckets the owner set by hand (see docs/TESTING.md). */
export type TruthTx = {
  id: string;
  occurred_on: string;
  amount: string;
  description: string;
  merchant: string | null;
  venue: string | null;
  funded_by: string;
  tags: string[];
  notes: string | null;
  lines: TruthLine[];
};

export type ComparedLine = {
  description: string;
  amount: string;
  category: string;
  subcategory: string;
  truth: Bucket;
  predicted: Bucket | null;
  why?: string;
};

export type BucketCase = {
  tx: TruthTx;
  message: string;
  model?: string;
  error?: string;
  lines: ComparedLine[];
};

export type Args = { sample: number; seed: number; rules: string; detail: boolean; dryRun: boolean };

function count(flag: string, value: string | undefined, min: number): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < min) {
    throw new Error(`${flag} needs a whole number of at least ${min}`);
  }
  return Number(value);
}

export function parseArgs(argv: string[], defaultRules: string): Args {
  const args: Args = { sample: 10, seed: 1, rules: defaultRules, detail: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--sample") args.sample = count(flag, argv[++i], 1);
    else if (flag === "--seed") args.seed = count(flag, argv[++i], 0);
    else if (flag === "--rules" && argv[i + 1]) args.rules = argv[++i];
    else if (flag === "--detail") args.detail = true;
    else if (flag === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

/** mulberry32: a small seeded PRNG, so a seed always picks the same cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` distinct items chosen by `seed` (partial Fisher-Yates). */
export function sample<T>(items: T[], n: number, seed: number): T[] {
  const pool = [...items];
  const next = rng(seed);
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(next() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

/** The text message the owner would plausibly have sent. It never states the bucket. */
export function messageFor(tx: TruthTx): string {
  let msg = `${tx.description} ${tx.amount}`;
  if (tx.merchant) msg += ` at ${tx.merchant}`;
  if (tx.venue) msg += ` (${tx.venue})`;
  if (tx.lines.length > 1) msg += `: ${tx.lines.map((l) => `${l.description} ${l.amount}`).join(", ")}`;
  if (tx.funded_by !== "self") msg += `, paid by ${tx.funded_by}`;
  if (tx.tags.length) msg += `, tags: ${tx.tags.join(", ")}`;
  if (tx.notes) msg += `. ${tx.notes}`;
  return msg;
}

/**
 * Pairs each owner line with a predicted expense line: same amount first,
 * else the same position. A line with no partner has no prediction.
 */
export function compareLines(tx: TruthTx, events: Extraction[]): ComparedLine[] {
  const predicted = events.filter((e) => e.type === "expense").flatMap((e) => e.items);
  const used = new Set<number>();
  return tx.lines.map((line, i) => {
    let j = predicted.findIndex((p, k) => !used.has(k) && parseCents(p.amount) === parseCents(line.amount));
    if (j < 0 && i < predicted.length && !used.has(i)) j = i;
    if (j >= 0) used.add(j);
    const p = j >= 0 ? predicted[j] : undefined;
    return {
      description: line.description,
      amount: line.amount,
      category: line.category,
      subcategory: line.subcategory,
      truth: line.bucket,
      predicted: p?.bucket ?? null,
      why: p?.bucket_why,
    };
  });
}

const CELLS = ["needs→needs", "needs→wants", "wants→needs", "wants→wants", "no answer"] as const;

/** stdout: agreement, per-category confusion (truth→predicted), model mix, mismatches. */
export function report(cases: BucketCase[]): string {
  const lines = cases.flatMap((c) => c.lines);
  const agree = lines.filter((l) => l.predicted === l.truth).length;
  const pct = lines.length ? `${((100 * agree) / lines.length).toFixed(1)}%` : "n/a";

  const byCategory = new Map<string, Record<(typeof CELLS)[number], number>>();
  for (const l of lines) {
    const row = byCategory.get(l.category) ?? Object.fromEntries(CELLS.map((c) => [c, 0]));
    row[l.predicted ? (`${l.truth}→${l.predicted}` as const) : "no answer"]++;
    byCategory.set(l.category, row as Record<(typeof CELLS)[number], number>);
  }
  const width = Math.max(8, ...[...byCategory.keys()].map((k) => k.length));
  const confusion = [
    `${"category".padEnd(width)} | ${CELLS.join(" | ")}`,
    ...[...byCategory].sort(([a], [b]) => a.localeCompare(b)).map(
      ([name, row]) => `${name.padEnd(width)} | ${CELLS.map((c) => String(row[c]).padEnd(c.length)).join(" | ")}`,
    ),
  ];

  const models = new Map<string, number>();
  for (const c of cases) models.set(c.model ?? "no model", (models.get(c.model ?? "no model") ?? 0) + 1);

  const mismatches = cases.flatMap((c) =>
    c.lines
      .filter((l) => l.predicted !== l.truth)
      .map((l) => {
        const note = l.predicted ? l.why : c.error;
        return (
          `- ${c.tx.occurred_on} ${l.category} / ${l.subcategory} "${l.description}" ${l.amount}: ` +
          `truth ${l.truth}, got ${l.predicted ?? "no answer"}${note ? ` (${note})` : ""}: "${c.message}"`
        );
      }),
  );

  return [
    `Agreement: ${agree} of ${lines.length} lines (${pct}) across ${cases.length} cases`,
    "",
    "Confusion by category (truth→predicted):",
    ...confusion,
    "",
    `Answered by: ${[...models].map(([m, n]) => `${m}: ${n}`).join(", ")}`,
    "",
    `Mismatches (${mismatches.length}):`,
    ...(mismatches.length ? mismatches : ["(none)"]),
    "",
  ].join("\n");
}

/** The pooler URL with its `postgres.<ref>` user swapped for `finflow_readonly.<ref>`. */
export function readonlyUrl(poolerUrl: string, password: string): string {
  const u = new URL(poolerUrl.trim());
  const ref = /^postgres\.(.+)$/.exec(u.username)?.[1];
  if (!ref) throw new Error("pooler URL user is not the postgres.<ref> form");
  u.username = `finflow_readonly.${ref}`;
  u.password = password;
  return u.toString();
}

export function geminiKey(
  env: Record<string, string | undefined>,
  envFile: Record<string, string | undefined>,
  envPath: string,
): string {
  const key = env.GEMINI_EVAL_API_KEY || envFile.GEMINI_EVAL_API_KEY;
  if (!key) {
    throw new Error(
      `GEMINI_EVAL_API_KEY is not set: export it or add GEMINI_EVAL_API_KEY=<key> to ${envPath}`,
    );
  }
  return key;
}
