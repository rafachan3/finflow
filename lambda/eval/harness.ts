import { mismatches, recordedEvents, type Golden } from "../tests/golden/golden.js";

/**
 * Paths that change what Gemini is asked (code, prompts, taxonomy seed and
 * the setup that loads it, dependencies) or how its answer is judged
 * (goldens, this harness, the CI job that runs it). Repo-relative.
 */
const RELEVANT = [
  "lambda/src/",
  "lambda/tests/golden/",
  "lambda/eval/",
  "lambda/tests/integration/global-setup.ts",
  "lambda/tests/integration/env.ts",
  "lambda/package.json",
  "lambda/package-lock.json",
  "supabase/migrations/",
  "supabase/seed.personal.example.sql",
  ".github/workflows/ci.yml",
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
// answered with a retryable status. Some may be out for the day, but
// geminiFetch throws its own error when all of them are, so at least one
// model here was overloaded or out of per-minute quota.
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
export async function retryOnce(
  name: string,
  attempt: () => Promise<string[]>,
): Promise<{ problems: string[]; attempts: number }> {
  let problems: string[] = [];
  for (let attempts = 1; ; attempts++) {
    try {
      problems = await attempt();
    } catch (err) {
      problems = [(err as Error).message];
    }
    if (problems.length === 0 || attempts === 2) return { problems, attempts };
    console.warn(`${name}: attempt 1 failed (${problems.join("; ")}); retrying`);
  }
}

function modelOf(input: Parameters<typeof fetch>[0]): string {
  const url = input instanceof Request ? input.url : String(input);
  return /\/models\/([^:/]+):/.exec(url)?.[1] ?? url;
}

type QuotaDetail = {
  violations?: { quotaId?: string; quotaValue?: string }[];
  retryDelay?: string;
};

/**
 * The eval's fetch: spaces Gemini requests `minGapMs` apart (start to
 * start) and logs the model and status of every response. Requests go to
 * `realFetch` exactly as production built them.
 *
 * A 429 logs its quotaId and retryDelay. A per-day quota will not come back
 * within the run, so that model is out for the rest of it: its 429 goes back
 * to production, which moves to the next model in `models` (its fallback
 * chain), and later requests to it get the same 429 without a call. Once
 * every model in `models` is out, every request throws instead of spending
 * the outage budget.
 */
export function geminiFetch(
  realFetch: typeof fetch,
  opts: {
    models: string[];
    minGapMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  },
): typeof fetch {
  let last = -Infinity;
  const outForDay = new Map<string, string>();
  const allOut = () =>
    new Error(
      `Gemini daily quota exhausted on every model (${[...outForDay].map(([m, q]) => `${m}: ${q}`).join(", ")}); it resets at midnight Pacific. Stopping instead of waiting.`,
    );
  return async (input, init) => {
    const model = modelOf(input);
    if (opts.models.every((m) => outForDay.has(m))) throw allOut();
    if (outForDay.has(model)) {
      const why = `daily quota exhausted earlier in this run (${outForDay.get(model)})`;
      console.log(`${model}: skipped, ${why}`);
      const body = { error: { code: 429, message: `${model}: ${why}` } };
      return new Response(JSON.stringify(body), { status: 429 });
    }
    const wait = last + opts.minGapMs - opts.now();
    if (wait > 0) await opts.sleep(wait);
    last = opts.now();
    const res = await realFetch(input, init);
    console.log(`${model}: HTTP ${res.status}`);
    if (res.status !== 429) return res;

    const body = await res.clone().json().catch(() => ({}));
    const details: QuotaDetail[] = body?.error?.details ?? [];
    const violations = details.flatMap((d) => d.violations ?? []);
    const ids = violations.map((v) => v.quotaId ?? "?");
    const limit = violations.find((v) => v.quotaValue)?.quotaValue;
    const delay = details.find((d) => d.retryDelay)?.retryDelay ?? "?";
    const quotaId = ids.join(",") || "?";
    console.log(
      `${model}: 429 quotaId=${quotaId} retryDelay=${delay}${limit ? ` limit=${limit}` : ""}`,
    );
    if (ids.some((id) => /PerDay/i.test(id))) {
      outForDay.set(model, quotaId);
      if (opts.models.every((m) => outForDay.has(m))) throw allOut();
    }
    return res;
  };
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

export type Answer = { raw: unknown; model: string | undefined };

/**
 * Runs `call` and returns the JSON of the first successful Gemini answer
 * and the model that gave it: the extractor's, before any bucket call.
 * That is what goldens record.
 */
export async function captureAnswer(call: () => Promise<unknown>): Promise<Answer> {
  const realFetch = globalThis.fetch;
  let first: Promise<unknown> | undefined;
  let model: string | undefined;
  globalThis.fetch = async (...args) => {
    const res = await realFetch(...args);
    if (res.ok && !first) {
      model = modelOf(args[0]);
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
  return { raw: await first, model };
}

export type CaseRow = { name: string; attempts: number; model: string | undefined; passed: boolean };

/** Markdown for the job summary: one row per case, then primary vs fallback counts. */
export function summary(rows: CaseRow[], primary: string): string {
  const count = (keep: (r: CaseRow) => boolean) => rows.filter(keep).length;
  return [
    "| case | attempts | answering model | result |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (r) => `| ${r.name} | ${r.attempts} | ${r.model ?? "none"} | ${r.passed ? "pass" : "fail"} |`,
    ),
    "",
    `Answered by the primary ${primary}: ${count((r) => r.model === primary)} of ${rows.length}. ` +
      `By a fallback: ${count((r) => !!r.model && r.model !== primary)}. ` +
      `By no model: ${count((r) => !r.model)}.`,
    "",
  ].join("\n");
}
