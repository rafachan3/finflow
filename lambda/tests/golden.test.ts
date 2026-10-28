import { describe, expect, it } from "vitest";
import {
  allGoldens,
  bucketRules,
  golden,
  mismatches,
  recordedEvents,
  type ExpectedEvent,
} from "./golden/golden.js";

describe("golden files", () => {
  it.each(allGoldens().map((g) => [g.file, g] as const))(
    "%s: the recording satisfies its expectation",
    (_file, g) => {
      expect(mismatches(recordedEvents(g), g.expect.events)).toEqual([]);
    },
  );

  it("edit cases correct an existing case", () => {
    for (const { input } of allGoldens()) {
      if (input.kind !== "edit") continue;
      const { base } = input;
      expect(() => golden(base)).not.toThrow();
    }
  });
});

describe("mismatches", () => {
  const two = golden("two-stores");

  it("reports a missing event", () => {
    expect(mismatches(recordedEvents(two).slice(0, 1), two.expect.events)).toEqual([
      "expected 2 events, got 1",
    ]);
  });

  it("reports a wrong type, line count, merchant and line sum", () => {
    const [first] = recordedEvents(two);
    const broken = {
      ...first,
      type: "income",
      amount: "9.00",
      merchant: null,
      items: [...(first.items ?? []), { amount: "1.00" }],
    };
    expect(mismatches([broken], [two.expect.events[0]])).toEqual([
      "event 0: type income != expense",
      "event 0: 2 lines != 1",
      "event 0: merchant missing",
    ]);
    expect(
      mismatches([{ ...first, amount: "9.00" }], [two.expect.events[0]]),
    ).toEqual(["event 0: lines sum 3.00 != 9.00"]);
  });

  it("reports each line whose bucket differs from the expected one", () => {
    const event = {
      type: "expense",
      amount: "3.00",
      items: [
        { description: "Milk", amount: "1.00", bucket: "needs" },
        { description: "Chips", amount: "1.00", bucket: "needs" },
        { description: "Soda", amount: "1.00" },
      ],
    };
    const want: ExpectedEvent = { type: "expense", lines: 3, buckets: ["needs", "wants", "wants"] };
    expect(mismatches([event], [want])).toEqual([
      "event 0: line 1 (Chips) bucket needs != wants",
      "event 0: line 2 (Soda) bucket undefined != wants",
    ]);
  });
});

describe("bucketRules", () => {
  it("is empty unless a case opts into a ruleset file", () => {
    expect(bucketRules(golden("text-with-note"))).toBe("");
    expect(bucketRules({ rules: "bucket-rules.synthetic.md" })).toMatch(/^Synthetic/);
  });

  it("an edit uses the same rules as its base, as production does", () => {
    for (const g of allGoldens()) {
      if (g.input.kind !== "edit") continue;
      expect(g.rules).toBe(golden(g.input.base).rules);
    }
  });
});
