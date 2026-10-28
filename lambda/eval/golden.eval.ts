import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadTaxonomy } from "../src/db.js";
import type { Extraction, TaxonomySnapshot } from "../src/extraction.js";
import {
  extractFromPhoto,
  extractFromText,
  extractFromVoice,
  patchExtraction,
} from "../src/gemini.js";
import { mimeTypeForPath } from "../src/telegram.js";
import { testDbUrl } from "../tests/integration/env.js";
import { allGoldens, golden, type Golden, type GoldenInput } from "../tests/golden/golden.js";
import { captureAnswer, outageWaiter, problems, recordedFile, retryOnce } from "./harness.js";

const GOLDEN_DIR = new URL("../tests/golden/", import.meta.url);
const RECORD = process.env.EVAL_RECORD === "1";

// Every model shedding load or out of quota: try again every 2 minutes, for
// at most 20 minutes in the whole run, then fail (the PR waits for Gemini).
const waitForGemini = outageWaiter({ budgetMs: 20 * 60_000, everyMs: 2 * 60_000, sleep });

let db: Client;
let taxonomy: TaxonomySnapshot;

function args() {
  return {
    apiKey: process.env.GEMINI_EVAL_API_KEY!,
    taxonomy,
    // Personal rules never leave SSM; the bot's no-rules fallback applies.
    bucketRules: "",
    today: new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" }),
  };
}

/** The production call for a message the owner sends (edits excluded). */
function extract(input: Exclude<GoldenInput, { kind: "edit" }>): Promise<Extraction[]> {
  if (input.kind === "text") return extractFromText({ ...args(), text: input.text });
  const media = {
    ...args(),
    caption: input.caption,
    mimeType: mimeTypeForPath(input.media),
  };
  const bytes = readFileSync(new URL(`media/${input.media}`, GOLDEN_DIR));
  return input.kind === "photo"
    ? extractFromPhoto({ ...media, image: bytes })
    : extractFromVoice({ ...media, audio: bytes });
}

/** Gemini's raw answer, the shape a golden records. */
async function liveAnswer(g: Golden): Promise<unknown> {
  const { input } = g;
  if (input.kind !== "edit") return captureAnswer(() => extract(input));
  // An edit corrects what the base message extracts live, as in the bot.
  const base = golden(input.base).input as Exclude<GoldenInput, { kind: "edit" }>;
  const [current] = await extract(base);
  return captureAnswer(() =>
    patchExtraction({ ...args(), current, correction: input.correction }),
  );
}

describe.skipIf(inject("evalSkip"))("live Gemini", () => {
  beforeAll(async () => {
    db = new Client({ connectionString: testDbUrl() });
    await db.connect();
    taxonomy = await loadTaxonomy(db);
  });

  afterAll(async () => {
    await db?.end();
  });

  it.each(allGoldens().map((g) => [g.file, g.name, g] as const))("%s: %s", async (_file, _name, g) => {
    let answer: unknown;
    const found = await retryOnce(async () => {
      answer = await waitForGemini(() => liveAnswer(g));
      return problems(g, answer);
    });
    if (RECORD && found.length === 0) {
      const file = new URL(`${g.file}.json`, GOLDEN_DIR);
      const next = recordedFile(readFileSync(file, "utf8"), answer);
      if (next) writeFileSync(file, next);
    }
    expect(found).toEqual([]);
  });
});
