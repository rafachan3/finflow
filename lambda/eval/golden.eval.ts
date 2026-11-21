import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadTaxonomy } from "../src/db.js";
import type { TaxonomySnapshot } from "../src/extraction.js";
import {
  GEMINI_FALLBACK_MODEL,
  GEMINI_LITE_MODEL,
  GEMINI_MODEL,
} from "../src/gemini.js";
import { testDbUrl } from "../tests/integration/env.js";
import { allGoldens, type Golden } from "../tests/golden/golden.js";
import {
  captureAnswer,
  geminiFetch,
  outageWaiter,
  productionProblems,
  recordedFile,
  repairOf,
  replay,
  requestHash,
  retryOnce,
  rotate,
  summary,
  type Answer,
  type CaseRow,
} from "./harness.js";
import { productionCall } from "./production.js";

const GOLDEN_DIR = new URL("../tests/golden/", import.meta.url);
// "1": write each live pass's answer and request hash; "hash": the hash only.
const RECORD = process.env.EVAL_RECORD;
const CHAIN = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_LITE_MODEL];
// Pinned so a case's request bytes do not change with the calendar, which
// would defeat the replay below. `expect` only checks whether a date is set.
const TODAY = "2026-10-28";
// The nightly run (.github/workflows/eval-nightly.yml) calls Gemini for every
// case and rotates the chain per case, so over three nights every case is
// answered by every model. PR runs keep production's order.
const NIGHTLY = process.env.EVAL_NIGHTLY === "1";
const DAY = Math.floor(Date.now() / 86_400_000);
const rows: CaseRow[] = [];
const limits = new Map<string, string>();

// Every model shedding load or out of per-minute quota: try again every 2
// minutes, for at most 20 minutes in the whole run, then fail (the PR waits
// for Gemini). A per-day quota fails at once in geminiFetch, but only once
// every model in production's fallback chain is out of it.
const waitForGemini = outageWaiter({ budgetMs: 20 * 60_000, everyMs: 2 * 60_000, sleep });

// Each case sends at most one request, so a full live run is one per case
// when every case passes first time.
// 13 s apart keeps the run under a 5-requests-per-minute free-tier limit.
const MIN_GAP_MS = 13_000;

let db: Client;
let taxonomy: TaxonomySnapshot;

/** The production call for a case (eval/production.ts, shared with the replay test). */
function call(g: Golden): () => Promise<unknown> {
  return productionCall(g, { apiKey: process.env.GEMINI_EVAL_API_KEY!, taxonomy, today: TODAY });
}

// Bases first, so an edit built on a base re-recorded in this run hashes
// the request it will really send next time.
const CASES = allGoldens().sort((a, b) => +(a.input.kind === "edit") - +(b.input.kind === "edit"));

describe.skipIf(inject("evalSkip"))("live Gemini", () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = geminiFetch(realFetch, {
      models: CHAIN,
      minGapMs: MIN_GAP_MS,
      now: Date.now,
      sleep,
      limits,
    });
    db = new Client({ connectionString: testDbUrl() });
    await db.connect();
    taxonomy = await loadTaxonomy(db);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db?.end();
    // Fallback answers are reported here, not failed. EVAL_SUMMARY_FILE is
    // the nightly issue's body.
    const md = `## Live Gemini eval\n\n${summary(rows, GEMINI_MODEL, limits)}`;
    for (const out of [process.env.GITHUB_STEP_SUMMARY, process.env.EVAL_SUMMARY_FILE]) {
      if (out) appendFileSync(out, md);
    }
  });

  it.each(CASES.map((g, i) => [g.file, g.name, g, i] as const))("%s: %s", async (_file, _name, g, i) => {
    // The request the current code builds, from the recording, no network.
    // A request that matches the one recorded as passing is not sent again:
    // the recording goes through today's code instead.
    const bodies: string[] = [];
    let replayError: string | undefined;
    let replayed: unknown;
    await replay(g.recorded, call(g), bodies).then(
      (result) => (replayed = result),
      (err: Error) => (replayError = err.message),
    );
    const hash = bodies[0] === undefined ? undefined : requestHash(CHAIN, bodies[0]);
    if (!NIGHTLY && hash && hash === g.request_sha256) {
      const found = replayError ? [replayError] : productionProblems(g, replayed);
      console.log(`${g.file}: request unchanged since it passed, replayed without a call`);
      rows.push({
        name: g.file,
        attempts: 0,
        model: undefined,
        replayed: true,
        repair: replayError ? undefined : repairOf(replayed),
        passed: found.length === 0,
      });
      expect(found).toEqual([]);
      return;
    }

    console.log(`${g.file}: request ${hash ?? "not built"} has no recorded pass, calling Gemini`);
    let answer: Answer | undefined;
    const { problems: found, attempts } = await retryOnce(g.file, async () => {
      answer = undefined;
      const route = NIGHTLY ? rotate(CHAIN, i + DAY) : undefined;
      answer = await waitForGemini(() => captureAnswer(call(g), route));
      // What the bot makes of the answer, the re-ask and the repair included.
      return productionProblems(g, answer.result);
    });
    const repair = answer ? repairOf(answer.result) : undefined;
    console.log(`${g.file}: ${attempts} attempt(s), answered by ${answer?.model ?? "no model"}, repair ${repair ?? "none"}`);
    rows.push({ name: g.file, attempts, model: answer?.model, repair, passed: found.length === 0 });
    // recordedFile refuses an answer that misses `expect` as read, with no re-ask or repair.
    if (RECORD && found.length === 0 && hash) {
      const file = new URL(`${g.file}.json`, GOLDEN_DIR);
      // --hashes keeps the recording the journeys assert on; the old one
      // satisfies `expect` too (golden.test.ts).
      const raw = RECORD === "hash" ? g.recorded : answer!.raw;
      const next = recordedFile(readFileSync(file, "utf8"), raw, hash);
      if (next) writeFileSync(file, next);
    }
    expect(found).toEqual([]);
  });
});
