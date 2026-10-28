import { mismatches, recordedEvents, type Golden } from "../tests/golden/golden.js";

/**
 * Paths that change what Gemini is asked (code, prompts, taxonomy seed) or
 * how its answer is judged (goldens, this harness). Repo-relative.
 */
const RELEVANT = [
  "lambda/src/",
  "lambda/tests/golden/",
  "lambda/eval/",
  "supabase/migrations/",
  "supabase/seed.personal.example.sql",
];

export function isRelevant(paths: string[]): boolean {
  return paths.some((p) => RELEVANT.some((r) => p === r || (r.endsWith("/") && p.startsWith(r))));
}

/**
 * Whether the eval calls Gemini. Without a usable base (a local run, a new
 * branch, a diff that fails) it runs: skipping is the only unsafe answer.
 */
export function shouldRun(
  base: string | undefined,
  diff: (base: string) => string[],
): { run: boolean; why: string } {
  if (!base || /^0+$/.test(base)) return { run: true, why: "no base commit: every case runs" };
  try {
    return isRelevant(diff(base))
      ? { run: true, why: "a relevant path changed" }
      : { run: false, why: "no extraction, prompt, golden or eval path changed" };
  } catch (err) {
    return { run: true, why: `diff failed (${(err as Error).message}): every case runs` };
  }
}

// gemini.ts throws this only after every model in its fallback chain
// answered with a retryable status.
const OUTAGE = /^Gemini HTTP (429|500|503|504)\b/;

/**
 * Wraps calls so an outage waits `everyMs` and tries again. The budget is
 * shared by every call through one waiter, so an outage bounds the run.
 */
export function outageWaiter(opts: {
  budgetMs: number;
  everyMs: number;
  sleep: (ms: number) => Promise<void>;
}): <T>(call: () => Promise<T>) => Promise<T> {
  let waited = 0;
  return async (call) => {
    for (;;) {
      try {
        return await call();
      } catch (err) {
        const outage = err instanceof Error && OUTAGE.test(err.message);
        if (!outage || waited + opts.everyMs > opts.budgetMs) throw err;
        console.warn(`${(err as Error).message}; waiting ${opts.everyMs / 1000}s for Gemini`);
        waited += opts.everyMs;
        await opts.sleep(opts.everyMs);
      }
    }
  };
}

/** A case gets two tries; the second answer (or error) is the verdict. */
export async function retryOnce(attempt: () => Promise<string[]>): Promise<string[]> {
  let problems: string[] = [];
  for (let i = 0; i < 2; i++) {
    try {
      problems = await attempt();
    } catch (err) {
      problems = [(err as Error).message];
    }
    if (problems.length === 0) return [];
  }
  return problems;
}

/** Problems with a live answer against a golden's `expect`; empty when it fits. */
export function problems(g: Pick<Golden, "input" | "expect">, raw: unknown): string[] {
  return mismatches(recordedEvents({ ...g, recorded: raw } as Golden), g.expect.events);
}

/** The golden file with `recorded` replaced, or null when `raw` misses `expect`. */
export function recordedFile(text: string, raw: unknown): string | null {
  const g = JSON.parse(text);
  if (problems(g, raw).length > 0) return null;
  return `${JSON.stringify({ ...g, recorded: raw }, null, 2)}\n`;
}

/**
 * Runs `call` and returns the JSON of the first successful Gemini answer:
 * the extractor's, before any bucket call. That is what goldens record.
 */
export async function captureAnswer(call: () => Promise<unknown>): Promise<unknown> {
  const realFetch = globalThis.fetch;
  let first: Promise<unknown> | undefined;
  globalThis.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.ok && !first) {
      first = res
        .clone()
        .json()
        .then((body) => JSON.parse(body.candidates[0].content.parts[0].text));
    }
    return res;
  };
  try {
    await call();
  } finally {
    globalThis.fetch = realFetch;
  }
  return first;
}
