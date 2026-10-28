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
import { todayToronto, withDatePolicy } from "../src/handler.js";
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
  retryOnce,
  summary,
  type Answer,
  type CaseRow,
} from "./harness.js";

const GOLDEN_DIR = new URL("../tests/golden/", import.meta.url);
const RECORD = process.env.EVAL_RECORD === "1";
const rows: CaseRow[] = [];

// Every model shedding load or out of per-minute quota: try again every 2
// minutes, for at most 20 minutes in the whole run, then fail (the PR waits
// for Gemini). A per-day quota fails at once in geminiFetch, but only once
// every model in production's fallback chain is out of it.
const waitForGemini = outageWaiter({ budgetMs: 20 * 60_000, everyMs: 2 * 60_000, sleep });

// Each case sends one request (an edit sends two: base, then patch), so a
// full run is 18 when every case passes first time.
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
    today: todayToronto(),
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

/** Gemini's raw answer (the shape a golden records) and the model that gave it. */
async function liveAnswer(g: Golden): Promise<Answer> {
  const { input } = g;
  if (input.kind !== "edit") return captureAnswer(() => extract(g, input));
  // An edit corrects what the base message extracts live, after the date
  // policy the bot applies before it stores the extraction an Edit patches.
  // Production sends one ruleset to both calls; golden.test.ts checks an
  // edit names the same rules as its base.
  const base = golden(input.base).input as Exclude<GoldenInput, { kind: "edit" }>;
  const [current] = (await extract(g, base)).map((e) =>
    withDatePolicy(normalizeTaxonomyNames(e, taxonomy), todayToronto(), base.kind),
  );
  return captureAnswer(() =>
    patchExtraction({ ...args(g), current, correction: input.correction }),
  );
}

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

  it.each(allGoldens().map((g) => [g.file, g.name, g] as const))("%s: %s", async (_file, _name, g) => {
    let answer: Answer | undefined;
    const { problems: found, attempts } = await retryOnce(g.file, async () => {
      answer = undefined;
      answer = await waitForGemini(() => liveAnswer(g));
      return problems(g, answer.raw);
    });
    console.log(`${g.file}: ${attempts} attempt(s), answered by ${answer?.model ?? "no model"}`);
    rows.push({ name: g.file, attempts, model: answer?.model, passed: found.length === 0 });
    if (RECORD && found.length === 0) {
      const file = new URL(`${g.file}.json`, GOLDEN_DIR);
      const next = recordedFile(readFileSync(file, "utf8"), answer!.raw);
      if (next) writeFileSync(file, next);
    }
    expect(found).toEqual([]);
  });
});
