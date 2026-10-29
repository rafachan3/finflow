import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadTaxonomy } from "../src/db.js";
import {
  normalizeTaxonomyNames,
  type Extraction,
  type TaxonomySnapshot,
} from "../src/extraction.js";
import {
  extractFromPhoto,
  extractFromText,
  extractFromVoice,
  GEMINI_FALLBACK_MODEL,
  GEMINI_LITE_MODEL,
  GEMINI_MODEL,
  patchExtraction,
} from "../src/gemini.js";
import { withDatePolicy } from "../src/handler.js";
import { mimeTypeForPath } from "../src/telegram.js";
import { testDbUrl } from "../tests/integration/env.js";
import {
  allGoldens,
  bucketRules,
  golden,
  type Golden,
  type GoldenInput,
} from "../tests/golden/golden.js";
import {
  captureAnswer,
  geminiFetch,
  outageWaiter,
  problems,
  recordedFile,
  replay,
  requestHash,
  retryOnce,
  summary,
  type Answer,
  type CaseRow,
} from "./harness.js";

const GOLDEN_DIR = new URL("../tests/golden/", import.meta.url);
const RECORD = process.env.EVAL_RECORD === "1";
const CHAIN = [GEMINI_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_LITE_MODEL];
// Pinned so a case's request bytes do not change with the calendar, which
// would defeat the replay below. `expect` only checks whether a date is set.
const TODAY = "2026-10-28";
const rows: CaseRow[] = [];

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

/**
 * Personal rules never leave SSM. A case runs with the bot's no-rules
 * fallback, or opts into a synthetic ruleset, which goes where production
 * sends `config.bucketRules`.
 */
function args(g: Golden) {
  return {
    apiKey: process.env.GEMINI_EVAL_API_KEY!,
    taxonomy,
    bucketRules: bucketRules(g),
    today: TODAY,
  };
}

/** The production call for a message the owner sends (edits excluded). */
function extract(g: Golden, input: Exclude<GoldenInput, { kind: "edit" }>): Promise<Extraction[]> {
  if (input.kind === "text") return extractFromText({ ...args(g), text: input.text });
  const media = {
    ...args(g),
    caption: input.caption,
    mimeType: mimeTypeForPath(input.media),
  };
  const bytes = readFileSync(new URL(`media/${input.media}`, GOLDEN_DIR));
  return input.kind === "photo"
    ? extractFromPhoto({ ...media, image: bytes })
    : extractFromVoice({ ...media, audio: bytes });
}

/** The production call for a case. */
function call(g: Golden): () => Promise<unknown> {
  const { input } = g;
  if (input.kind !== "edit") return () => extract(g, input);
  // An edit corrects the base case's recorded answer, after the date policy
  // the bot applies before it stores the extraction an Edit patches. The
  // base's own case checks Gemini on the base message. Production sends one
  // ruleset to both calls; golden.test.ts checks an edit names the same
  // rules as its base. Read at run time: a --record run re-records bases
  // before edits (see the case order below).
  return async () => {
    const base = golden(input.base);
    const message = base.input as Exclude<GoldenInput, { kind: "edit" }>;
    const [current] = (await replay(base.recorded, () => extract(g, message))).map((e) =>
      withDatePolicy(normalizeTaxonomyNames(e, taxonomy), TODAY, message.kind),
    );
    return patchExtraction({ ...args(g), current, correction: input.correction });
  };
}

// Bases first, so an edit built on a base re-recorded in this run hashes
// the request it will really send next time.
const CASES = allGoldens().sort((a, b) => +(a.input.kind === "edit") - +(b.input.kind === "edit"));

describe.skipIf(inject("evalSkip"))("live Gemini", () => {
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    globalThis.fetch = geminiFetch(realFetch, {
      models: [GEMINI_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_LITE_MODEL],
      minGapMs: MIN_GAP_MS,
      now: Date.now,
      sleep,
    });
    db = new Client({ connectionString: testDbUrl() });
    await db.connect();
    taxonomy = await loadTaxonomy(db);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db?.end();
    // Fallback answers are reported here, not failed.
    const out = process.env.GITHUB_STEP_SUMMARY;
    if (out) appendFileSync(out, `## Live Gemini eval\n\n${summary(rows, GEMINI_MODEL)}`);
  });

  it.each(CASES.map((g) => [g.file, g.name, g] as const))("%s: %s", async (_file, _name, g) => {
    // The request the current code builds, from the recording, no network.
    // A request that matches the one recorded as passing is not sent again:
    // the recording goes through today's code instead.
    const bodies: string[] = [];
    let replayError: string | undefined;
    await replay(g.recorded, call(g), bodies).catch((err: Error) => (replayError = err.message));
    const hash = bodies[0] === undefined ? undefined : requestHash(CHAIN, bodies[0]);
    if (hash && hash === g.request_sha256) {
      const found = replayError ? [replayError] : problems(g, g.recorded);
      console.log(`${g.file}: request unchanged since it passed, replayed without a call`);
      rows.push({ name: g.file, attempts: 0, model: undefined, replayed: true, passed: found.length === 0 });
      expect(found).toEqual([]);
      return;
    }

    console.log(`${g.file}: request ${hash ?? "not built"} has no recorded pass, calling Gemini`);
    let answer: Answer | undefined;
    const { problems: found, attempts } = await retryOnce(g.file, async () => {
      answer = undefined;
      answer = await waitForGemini(() => captureAnswer(call(g)));
      return problems(g, answer.raw);
    });
    console.log(`${g.file}: ${attempts} attempt(s), answered by ${answer?.model ?? "no model"}`);
    rows.push({ name: g.file, attempts, model: answer?.model, passed: found.length === 0 });
    if (RECORD && found.length === 0 && hash) {
      const file = new URL(`${g.file}.json`, GOLDEN_DIR);
      const next = recordedFile(readFileSync(file, "utf8"), answer!.raw, hash);
      if (next) writeFileSync(file, next);
    }
    expect(found).toEqual([]);
  });
});
