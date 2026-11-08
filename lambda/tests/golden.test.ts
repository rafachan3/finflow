import { describe, expect, it } from "vitest";
import {
  allGoldens,
  bucketRules,
  golden,
  mismatches,
  recordedEvents,
  type ExpectedEvent,
  type Golden,
} from "./golden/golden.js";

describe("golden files", () => {
  it.each(allGoldens().map((g) => [g.file, g] as const))(
    "%s: the recording satisfies its expectation",
    (_file, g) => {
      expect(mismatches(recordedEvents(g), g.expect.events)).toEqual([]);
    },
  );

  it("a full eval run fits gemini-3.6-flash's 20 free requests a day", () => {
    // One request per case: an edit patches its base's recorded answer.
    expect(allGoldens().length).toBeLessThanOrEqual(20);
  });

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

  it("reports a header amount other than the expected one", () => {
    const event = { type: "expense", amount: "28.74", items: [{ amount: "28.74" }] };
    expect(mismatches([event], [{ type: "expense", lines: 1, amount: "33.24" }])).toEqual([
      "event 0: amount 28.74 != 33.24",
    ]);
    expect(mismatches([event], [{ type: "expense", lines: 1, amount: "28.74" }])).toEqual([]);
  });

  it("reads prices, taxes and tip as the bot does, and reports line amounts other than the expected ones", () => {
    const diner = {
      type: "expense",
      amount: "33.24",
      taxes: ["1.25", "2.49"],
      tip: "4.50",
      items: [
        { price: "16.00", taxable: false },
        { price: "9.00", taxable: false },
      ],
    };
    const g = { input: { kind: "photo" }, recorded: { events: [diner] } } as unknown as Golden;
    const want: ExpectedEvent = { type: "expense", lines: 2, amount: "33.24", amounts: ["21.27", "11.97"] };
    expect(mismatches(recordedEvents(g), [want])).toEqual([]);
    expect(mismatches(recordedEvents(g), [{ ...want, amounts: ["21.26", "11.98"] }])).toEqual([
      "event 0: line amounts 21.27 + 11.97 != 21.26 + 11.98",
    ]);
  });

  it("judges an edit's total as patchExtraction keeps it: the recomputed lines unless the total changed", () => {
    const base = recordedEvents(golden("receipt-with-tip"))[0];
    const edit = (amount: string) =>
      ({
        input: { kind: "edit", base: "receipt-with-tip", correction: "tip 6" },
        recorded: {
          type: "expense",
          amount,
          taxes: ["1.25", "2.49"],
          tip: "6.00",
          items: [
            { price: "16.00", taxable: false },
            { price: "9.00", taxable: false },
          ],
        },
      }) as unknown as Golden;
    expect(recordedEvents(edit(String(base.amount)))[0].amount).toBe("34.74");
    expect(recordedEvents(edit("39.24"))[0].amount).toBe("39.24");
  });

  it("reports a date or venue other than the expected one", () => {
    const want: ExpectedEvent = { type: "expense", lines: 1, dateIs: "2026-10-24", venue: null };
    const event = (date: string, venue: string | null) =>
      mismatches([{ type: "expense", amount: "3.00", date, venue, items: [{ amount: "3.00" }] }], [want]);
    expect(event("2026-10-24", null)).toEqual([]);
    // Day/month/year read years in the past, and the nearest venue picked.
    expect(event("2024-10-26", "Fast Food")).toEqual([
      "event 0: date 2024-10-26 != 2026-10-24",
      "event 0: venue Fast Food != null",
    ]);
  });

  it("reports a transfer's accounts, reading a recording without from_account as chequing", () => {
    const want: ExpectedEvent = { type: "transfer", lines: 0, fromAccount: "Savings", toAccount: null };
    const deposit = { type: "transfer", items: [], to_account: "Savings" };
    expect(mismatches([deposit], [want])).toEqual([
      "event 0: from account null != Savings",
      "event 0: to account Savings != null",
    ]);
    const withdrawal = { type: "transfer", items: [], from_account: "Savings", to_account: null };
    expect(mismatches([withdrawal], [want])).toEqual([]);
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

  it("reports each line whose category, subcategory or item type differs from the expected one", () => {
    const want: ExpectedEvent = { type: "expense", lines: 2, classes: ["Housing / Laundry", "Housing / Laundry"] };
    const line = (description: string, item_type: string | null) => ({
      description,
      amount: "1.00",
      category: "Housing",
      subcategory: "Laundry",
      item_type,
    });
    const event = (types: (string | null)[]) =>
      mismatches([{ type: "expense", amount: "2.00", items: [line("Washer", types[0]), line("Dryer", types[1])] }], [want]);
    expect(event([null, null])).toEqual([]);
    expect(event(["Laundry Supply", null])).toEqual([
      "event 0: line 0 (Washer) Housing / Laundry / Laundry Supply != Housing / Laundry",
    ]);
  });

  it("compares classes as stored, after the repeated category prefix is stripped", () => {
    const want: ExpectedEvent = { type: "expense", lines: 1, classes: ["Food and drink / Restaurants / Meals & Prepared Food"] };
    const line = (subcategory: string, item_type: string) => ({
      amount: "1.00",
      category: "Food and drink",
      subcategory,
      item_type,
    });
    const event = (subcategory: string, item_type: string) =>
      mismatches([{ type: "expense", amount: "1.00", items: [line(subcategory, item_type)] }], [want]);
    expect(event("Restaurants", "Meals & Prepared Food")).toEqual([]);
    expect(event("Food and drink / Restaurants", "Food and drink / Meals & Prepared Food")).toEqual([]);
    expect(event("Food and drink / Takeout / Quick Service", "Meals & Prepared Food")).toEqual([
      "event 0: line 0 (undefined) Food and drink / Takeout / Quick Service / Meals & Prepared Food != Food and drink / Restaurants / Meals & Prepared Food",
    ]);
  });

  it("reports header tags and each line's own tags, once a tag on every line counts as the header's", () => {
    const want: ExpectedEvent = { type: "expense", lines: 2, tags: ["Travel"], lineTags: [[], ["Partner"]] };
    const line = (tags?: string[]) => ({ amount: "1.00", tags });
    const event = (tags: string[], lines: (string[] | undefined)[]) =>
      mismatches([{ type: "expense", amount: "2.00", tags, items: lines.map(line) }], [want]);
    expect(event(["Travel"], [[], ["Partner"]])).toEqual([]);
    expect(event([], [["Travel"], ["Travel", "Partner"]])).toEqual([]);
    expect(event([], [undefined, ["Partner"]])).toEqual(["event 0: tags [] != [Travel]"]);
    expect(event(["Travel"], [["Partner"], []])).toEqual([
      "event 0: line 0 tags [Partner] != []",
      "event 0: line 1 tags [] != [Partner]",
    ]);
  });

  it("reports a note that keeps a typo, misses a correction, or grows too long", () => {
    const want: ExpectedEvent = {
      type: "income",
      lines: 0,
      noteHas: ["tired", "didn't"],
      noteLacks: ["tierd", "pak"],
      noteMaxWords: 6,
    };
    const note = (notes: string) => mismatches([{ type: "income", items: [], notes }], [want]);
    expect(note("I was too tired and didn’t pack lunch")).toEqual([
      "event 0: note has 8 words > 6",
    ]);
    expect(note("was tierd, didnt pak lunch")).toEqual([
      'event 0: note lacks "tired"',
      'event 0: note lacks "didn\'t"',
      'event 0: note has "tierd"',
      'event 0: note has "pak"',
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
