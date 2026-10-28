import { describe, expect, it } from "vitest";
import {
  compareLines,
  geminiKey,
  messageFor,
  parseArgs,
  readonlyUrl,
  report,
  sample,
  type BucketCase,
  type TruthTx,
} from "../eval/buckets.js";
import type { Extraction } from "../src/extraction.js";

const tx = (over: Partial<TruthTx> = {}): TruthTx => ({
  id: "t1",
  occurred_on: "2026-06-02",
  amount: "12.50",
  description: "Lunch",
  merchant: null,
  venue: null,
  funded_by: "self",
  tags: [],
  notes: null,
  lines: [
    {
      description: "Lunch",
      amount: "12.50",
      category: "Food and drink",
      subcategory: "Takeout / Quick Service",
      bucket: "wants",
    },
  ],
  ...over,
});

const event = (items: { amount: string; bucket: "needs" | "wants"; why?: string }[]): Extraction => ({
  type: "expense",
  amount: "0.00",
  currency: "CAD",
  date: "",
  description: "x",
  merchant: null,
  venue: null,
  tags: [],
  funded_by: "self",
  is_recurring: false,
  income_source: null,
  to_account: null,
  confidence: 0.9,
  items: items.map((i) => ({
    description: "x",
    amount: i.amount,
    category: "Food and drink",
    subcategory: "Groceries",
    item_type: null,
    bucket: i.bucket,
    bucket_why: i.why,
  })),
});

describe("parseArgs", () => {
  it("defaults to 10 cases, seed 1, the given rules path, no detail", () => {
    expect(parseArgs([], "/r.md")).toEqual({
      sample: 10,
      seed: 1,
      rules: "/r.md",
      detail: false,
      dryRun: false,
    });
  });

  it("reads --sample, --seed, --rules, --detail and --dry-run", () => {
    expect(
      parseArgs(["--sample", "3", "--seed", "7", "--rules", "/x.md", "--detail", "--dry-run"], "/r.md"),
    ).toEqual({ sample: 3, seed: 7, rules: "/x.md", detail: true, dryRun: true });
  });

  it.each([["--sample", "0"], ["--sample", "abc"], ["--seed", "-1"], ["--bogus"]])(
    "rejects %s %s",
    (...argv) => {
      expect(() => parseArgs(argv.filter(Boolean), "/r.md")).toThrow();
    },
  );
});

describe("sample", () => {
  const ids = Array.from({ length: 50 }, (_, i) => i);

  it("picks the same cases for the same seed", () => {
    expect(sample(ids, 5, 1)).toEqual(sample(ids, 5, 1));
  });

  it("picks different cases for a different seed", () => {
    expect(sample(ids, 5, 1)).not.toEqual(sample(ids, 5, 2));
  });

  it("picks n distinct items, or all of them when there are fewer", () => {
    expect(new Set(sample(ids, 5, 1)).size).toBe(5);
    expect(sample([1, 2], 5, 1).sort()).toEqual([1, 2]);
  });
});

describe("messageFor", () => {
  it("writes a one-line expense as description and amount", () => {
    expect(messageFor(tx())).toBe("Lunch 12.50");
  });

  it("adds merchant, venue, funder, tags and notes when present", () => {
    const msg = messageFor(
      tx({
        merchant: "Acme Mart",
        venue: "Supermarket",
        funded_by: "Example Funder",
        tags: ["Travel"],
        notes: "for the trip",
      }),
    );
    expect(msg).toBe(
      "Lunch 12.50 at Acme Mart (Supermarket), paid by Example Funder, tags: Travel. for the trip",
    );
  });

  it("lists each line of a multi-line expense", () => {
    const msg = messageFor(
      tx({
        description: "Groceries",
        amount: "10.00",
        lines: [
          { description: "Milk", amount: "4.00", category: "c", subcategory: "s", bucket: "needs" },
          { description: "Chips", amount: "6.00", category: "c", subcategory: "s", bucket: "wants" },
        ],
      }),
    );
    expect(msg).toBe("Groceries 10.00: Milk 4.00, Chips 6.00");
  });

  it("never states the bucket", () => {
    expect(messageFor(tx())).not.toMatch(/needs|wants/i);
  });
});

describe("compareLines", () => {
  it("matches lines by amount before position", () => {
    const t = tx({
      lines: [
        { description: "A", amount: "4.00", category: "c", subcategory: "s", bucket: "needs" },
        { description: "B", amount: "6.00", category: "c", subcategory: "s", bucket: "wants" },
      ],
    });
    const out = compareLines(t, [
      event([
        { amount: "6.00", bucket: "wants" },
        { amount: "4.00", bucket: "needs", why: "staple" },
      ]),
    ]);
    expect(out.map((l) => [l.truth, l.predicted, l.why])).toEqual([
      ["needs", "needs", "staple"],
      ["wants", "wants", undefined],
    ]);
  });

  it("falls back to position when no amount matches", () => {
    const out = compareLines(tx(), [event([{ amount: "12.49", bucket: "needs" }])]);
    expect(out[0].predicted).toBe("needs");
  });

  it("leaves a line unanswered when the answer has no expense line for it", () => {
    const income = { ...event([{ amount: "12.50", bucket: "wants" }]), type: "income" as const };
    expect(compareLines(tx(), [income])[0].predicted).toBeNull();
    expect(compareLines(tx(), [])[0].predicted).toBeNull();
  });
});

describe("report", () => {
  const line = (category: string, truth: "needs" | "wants", predicted: "needs" | "wants" | null) => ({
    description: "Item",
    amount: "1.00",
    category,
    subcategory: "Sub",
    truth,
    predicted,
  });
  const cases: BucketCase[] = [
    { tx: tx(), message: "m1", model: "gemini-a", lines: [line("Food", "needs", "needs")] },
    { tx: tx(), message: "m2", model: "gemini-b", lines: [line("Food", "wants", "needs")] },
    { tx: tx(), message: "m3", model: "gemini-a", lines: [line("Home", "needs", "needs")] },
    { tx: tx(), message: "m4", error: "Gemini HTTP 503", lines: [line("Home", "wants", null)] },
  ];
  const text = report(cases);

  it("shows agreement over every sampled line", () => {
    expect(text).toContain("Agreement: 2 of 4 lines (50.0%)");
  });

  it("shows per-category confusion", () => {
    expect(text).toMatch(/Food\s+\|\s+1\s+\|\s+0\s+\|\s+1\s+\|\s+0\s+\|\s+0/);
    expect(text).toMatch(/Home\s+\|\s+1\s+\|\s+0\s+\|\s+0\s+\|\s+0\s+\|\s+1/);
  });

  it("shows which model answered each case", () => {
    expect(text).toContain("gemini-a: 2");
    expect(text).toContain("gemini-b: 1");
    expect(text).toContain("no model: 1");
  });

  it("lists each mismatch with its message", () => {
    expect(text).toContain('truth wants, got needs: "m2"');
    expect(text).toContain('truth wants, got no answer (Gemini HTTP 503): "m4"');
    expect(text).not.toContain('"m1"');
  });
});

describe("readonlyUrl", () => {
  it("swaps the pooler user for the read-only role and sets its password", () => {
    const url = readonlyUrl("postgresql://postgres.abc123@pooler.example.com:5432/postgres\n", "p@ss");
    const u = new URL(url);
    expect(u.username).toBe("finflow_readonly.abc123");
    expect(decodeURIComponent(u.password)).toBe("p@ss");
    expect(u.host).toBe("pooler.example.com:5432");
  });

  it("refuses a URL whose user is not the postgres.<ref> form", () => {
    expect(() => readonlyUrl("postgresql://someone@h:5432/postgres", "p")).toThrow(/postgres\.<ref>/);
  });
});

describe("geminiKey", () => {
  it("prefers the environment, then the env file", () => {
    expect(geminiKey({ GEMINI_EVAL_API_KEY: "a" }, { GEMINI_EVAL_API_KEY: "b" }, "/e")).toBe("a");
    expect(geminiKey({}, { GEMINI_EVAL_API_KEY: "b" }, "/e")).toBe("b");
  });

  it("fails with one line naming the file when the key is missing", () => {
    expect(() => geminiKey({}, {}, "/repo/.env")).toThrow(
      "GEMINI_EVAL_API_KEY is not set: export it or add GEMINI_EVAL_API_KEY=<key> to /repo/.env",
    );
  });
});
