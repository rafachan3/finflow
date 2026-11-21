import { readFileSync } from "node:fs";
import {
  normalizeTaxonomyNames,
  type Extraction,
  type TaxonomySnapshot,
} from "../src/extraction.js";
import { extractFromPhoto, extractFromText, extractFromVoice, patchExtraction } from "../src/gemini.js";
import { withDatePolicy } from "../src/handler.js";
import { mimeTypeForPath } from "../src/telegram.js";
import { bucketRules, golden, type Golden, type GoldenInput } from "../tests/golden/golden.js";
import { replay } from "./harness.js";

const GOLDEN_DIR = new URL("../tests/golden/", import.meta.url);

/** What a case runs against: the key, the taxonomy and the pinned date. */
export type Run = { apiKey: string; taxonomy: TaxonomySnapshot; today: string };

/**
 * Personal rules never leave SSM. A case runs with the bot's no-rules
 * fallback, or opts into a synthetic ruleset, which goes where production
 * sends `config.bucketRules`.
 */
function args(g: Golden, run: Run) {
  return { apiKey: run.apiKey, taxonomy: run.taxonomy, bucketRules: bucketRules(g), today: run.today };
}

/** The production call for a message the owner sends (edits excluded). */
function extract(g: Golden, run: Run, input: Exclude<GoldenInput, { kind: "edit" }>): Promise<Extraction[]> {
  if (input.kind === "text") return extractFromText({ ...args(g, run), text: input.text });
  const media = {
    ...args(g, run),
    caption: input.caption,
    mimeType: mimeTypeForPath(input.media),
  };
  const bytes = readFileSync(new URL(`media/${input.media}`, GOLDEN_DIR));
  return input.kind === "photo"
    ? extractFromPhoto({ ...media, image: bytes })
    : extractFromVoice({ ...media, audio: bytes });
}

/**
 * The production call for a case: what the bot makes of the owner's message,
 * the first answer, the re-ask and the one-line repair included. It returns
 * the extractions the cards are built from.
 */
export function productionCall(g: Golden, run: Run): () => Promise<unknown> {
  const { input } = g;
  if (input.kind !== "edit") return () => extract(g, run, input);
  // An edit corrects the base case's recorded answer, after the date policy
  // the bot applies before it stores the extraction an Edit patches. The
  // base's own case checks Gemini on the base message. Production sends one
  // ruleset to both calls; golden.test.ts checks an edit names the same
  // rules as its base. Read at run time: a --record run re-records bases
  // before edits (see the case order in golden.eval.ts).
  return async () => {
    const base = golden(input.base);
    const message = base.input as Exclude<GoldenInput, { kind: "edit" }>;
    const [current] = (await replay(base.recorded, () => extract(g, run, message))).map((e) =>
      withDatePolicy(normalizeTaxonomyNames(e, run.taxonomy), run.today, message.kind),
    );
    return patchExtraction({ ...args(g, run), current, correction: input.correction });
  };
}
