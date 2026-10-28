import { describe, expect, it } from "vitest";
import { allGoldens, golden, mismatches, recordedEvents } from "./golden/golden.js";

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
});
