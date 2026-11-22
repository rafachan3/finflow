import { beforeAll, describe, expect, it } from "vitest";
import { productionProblems, repairOf, replay } from "../../eval/harness.js";
import { productionCall } from "../../eval/production.js";
import { loadTaxonomy } from "../../src/db.js";
import type { TaxonomySnapshot } from "../../src/extraction.js";
import { allGoldens, golden } from "../golden/golden.js";
import { withClient } from "./db-helpers.js";

// The live eval judges what the bot makes of Gemini's answer (the first
// answer, the re-ask, the one-line repair). Here each recording goes through
// the same production call with no network.
let taxonomy: TaxonomySnapshot;

beforeAll(async () => {
  taxonomy = await withClient((client) => loadTaxonomy(client));
});

const run = () => ({ apiKey: "replayed", taxonomy, today: "2026-10-28" });

describe("golden cases through the production call", () => {
  it.each(allGoldens().map((g) => [g.file, g] as const))(
    "%s: the recording becomes extractions that satisfy its expectation, with no repair",
    async (_file, g) => {
      const made = await replay(g.recorded, productionCall(g, run()));
      expect(productionProblems(g, made)).toEqual([]);
      expect(repairOf(made)).toBe("none");
    },
  );

  it("the caption purchase answered with no items is read again, and a failed re-ask leaves the one-line fallback, which the case refuses", async () => {
    const g = golden("receipt-with-caption");
    const [receipt, caption] = (g.recorded as { events: object[] }).events;
    const noItems = { events: [receipt, { ...caption, items: [] }] };
    // First answer lacks the caption's items; the re-ask answers like the recording does.
    let calls = 0;
    const before = globalThis.fetch;
    globalThis.fetch = (async () => {
      const answer = calls++ === 0 ? noItems : { events: [caption] };
      const text = JSON.stringify(answer);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }) as typeof fetch;
    try {
      const made = await productionCall(g, run())();
      expect(calls).toBe(2);
      expect(repairOf(made)).toBe("re-ask");
      expect(productionProblems(g, made)).toEqual([]);
    } finally {
      globalThis.fetch = before;
    }

    // The same first answer, then a re-ask that gives no items again.
    let n = 0;
    globalThis.fetch = (async () => {
      const answer = n++ === 0 ? noItems : { events: [{ ...caption, items: [] }] };
      const text = JSON.stringify(answer);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
    }) as typeof fetch;
    try {
      const stuck = await productionCall(g, run())();
      expect(n).toBe(2);
      expect(repairOf(stuck)).toBe("fallback");
      expect(productionProblems(g, stuck)).toEqual([
        "event 1: no items were read; its one line has the generic category made from the total",
      ]);
    } finally {
      globalThis.fetch = before;
    }
  });
});
