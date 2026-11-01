import { describe, expect, it } from "vitest";
import {
  applyDatePolicy,
  duplicateWarnings,
  formatPreview,
  merchantHint,
  withPosition,
  fundingSourceToPersist,
  normalizeTaxonomyNames,
  parseCents,
  parseDateReply,
  validateExtraction,
  type Extraction,
  type TaxonomySnapshot,
} from "../src/extraction.js";

const taxonomy: TaxonomySnapshot = {
  subcategories: [
    {
      category: "Food and drink",
      name: "Takeout / Quick Service",
      default_bucket: "wants",
    },
    {
      category: "Food and drink",
      name: "Groceries",
      default_bucket: null,
    },
    { category: "Personal", name: "Other personal", default_bucket: "wants" },
  ],
  itemTypes: [
    { category: "Food and drink", name: "Meals & Prepared Food" },
    { category: "Food and drink", name: "Non-Alcoholic Beverages" },
  ],
  venues: ["Fast Food", "Supermarket"],
  tags: ["Social", "Travel"],
  fundingSources: ["self"],
  merchants: ["McDonald's"],
  incomeSources: ["Salary"],
  accounts: ["Rainy-day fund"],
};

function expense(overrides: Partial<Extraction> = {}): Extraction {
  return {
    type: "expense",
    amount: "27.60",
    currency: "CAD",
    date: "2026-08-17",
    description: "McDonald's lunch",
    merchant: "McDonald's",
    venue: "Fast Food",
    tags: ["Social"],
    funded_by: "self",
    is_recurring: false,
    income_source: null,
    to_account: null,
    items: [
      {
        description: "Burger combo",
        amount: "19.55",
        category: "Food and drink",
        subcategory: "Takeout / Quick Service",
        item_type: "Meals & Prepared Food",
        bucket: "wants",
      },
      {
        description: "Coke",
        amount: "8.05",
        category: "Food and drink",
        subcategory: "Takeout / Quick Service",
        item_type: "Non-Alcoholic Beverages",
        bucket: "wants",
      },
    ],
    confidence: 0.9,
    ...overrides,
  };
}

describe("parseCents", () => {
  it("parses two-decimal money as integer cents", () => {
    expect(parseCents("27.60")).toBe(2760);
    expect(parseCents("8.05")).toBe(805);
  });

  it("rejects floats that are not two-decimal strings", () => {
    expect(parseCents("27.6")).toBeNull();
    expect(parseCents("27")).toBeNull();
    expect(parseCents("1.234")).toBeNull();
  });
});

describe("parseDateReply", () => {
  const today = "2026-08-18";

  it("accepts ISO, today, yesterday, and month-day names", () => {
    expect(parseDateReply("2026-08-10", today)).toBe("2026-08-10");
    expect(parseDateReply("today", today)).toBe("2026-08-18");
    expect(parseDateReply("yesterday", today)).toBe("2026-08-17");
    expect(parseDateReply("Aug 10", today)).toBe("2026-08-10");
    expect(parseDateReply("August 10", today)).toBe("2026-08-10");
  });

  it("uses last year when a month-day would be in the future", () => {
    expect(parseDateReply("Dec 20", "2026-08-18")).toBe("2025-12-20");
  });

  it("rejects a new expense or an impossible calendar day", () => {
    expect(parseDateReply("12.50 lunch chipotle", today)).toBeNull();
    expect(parseDateReply("2026-02-31", today)).toBeNull();
  });
});

describe("applyDatePolicy", () => {
  const today = "2026-08-18";

  it("keeps a stated ISO date on text and photo", () => {
    expect(applyDatePolicy({ channel: "text", extractedDate: "2026-08-10", today })).toEqual({
      date: "2026-08-10",
      date_source: "stated",
      warnings: [],
      errors: [],
    });
    expect(applyDatePolicy({ channel: "photo", extractedDate: "2026-08-10", today }).date_source).toBe(
      "stated",
    );
  });

  it("defaults text with no date to today and warns", () => {
    const result = applyDatePolicy({ channel: "text", extractedDate: null, today });
    expect(result.date).toBe(today);
    expect(result.date_source).toBe("today_default");
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => /defaulted to today/i.test(w))).toBe(true);
  });

  it("does not default a photo with no date", () => {
    const result = applyDatePolicy({ channel: "photo", extractedDate: "", today });
    expect(result.date).toBe("");
    expect(result.date_source).toBe("missing");
    expect(result.errors.some((e) => /date/i.test(e))).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("validateExtraction", () => {
  it("accepts a balanced expense with live taxonomy", () => {
    const result = validateExtraction(expense(), taxonomy);
    expect(result.ok).toBe(true);
  });

  it("rejects when line cents do not sum to the header", () => {
    const result = validateExtraction(
      expense({
        items: [
          {
            description: "Burger",
            amount: "19.55",
            category: "Food and drink",
            subcategory: "Takeout / Quick Service",
            item_type: "Meals & Prepared Food",
            bucket: "wants",
          },
        ],
      }),
      taxonomy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("sum"))).toBe(true);
    }
  });

  it("rejects an item_type from a different category than the subcategory", () => {
    const result = validateExtraction(
      expense({
        amount: "19.55",
        items: [
          {
            description: "Burger",
            amount: "19.55",
            category: "Personal",
            subcategory: "Other personal",
            item_type: "Meals & Prepared Food",
            bucket: "wants",
          },
        ],
      }),
      taxonomy,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unknown venue or tag", () => {
    expect(
      validateExtraction(expense({ venue: "Space Station" }), taxonomy).ok,
    ).toBe(false);
    expect(
      validateExtraction(expense({ tags: ["NotATag"] }), taxonomy).ok,
    ).toBe(false);
  });

  it("warns when the date was defaulted to today and still allows confirm", () => {
    const result = validateExtraction(
      expense({ date: "2026-08-18", date_source: "today_default" }),
      taxonomy,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /defaulted to today/i.test(w))).toBe(true);
  });

  it("rejects a missing date", () => {
    const result = validateExtraction(
      expense({ date: "", date_source: "missing" }),
      taxonomy,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /date/i.test(e))).toBe(true);
    }
  });

  it("allows an unknown merchant (nullable FK)", () => {
    const result = validateExtraction(
      expense({ merchant: "New Cafe" }),
      taxonomy,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /merchant/i.test(w))).toBe(true);
  });

  it("finds a listed merchant whatever its case, spacing or apostrophe", () => {
    const result = validateExtraction(expense({ merchant: " MCDONALD’S " }), taxonomy);
    expect(result.warnings.some((w) => /merchant/i.test(w))).toBe(false);
  });

  it("requires income_source and no lines on income", () => {
    const result = validateExtraction(
      expense({
        type: "income",
        amount: "2000.00",
        items: [],
        income_source: "Salary",
        merchant: null,
        venue: null,
        tags: [],
      }),
      taxonomy,
    );
    expect(result.ok).toBe(true);

    const withLines = validateExtraction(
      expense({
        type: "income",
        income_source: "Salary",
      }),
      taxonomy,
    );
    expect(withLines.ok).toBe(false);
  });

  it("allows income with no funding source", () => {
    const result = validateExtraction(
      expense({
        type: "income",
        amount: "2000.00",
        items: [],
        income_source: "Salary",
        merchant: null,
        venue: null,
        tags: [],
        funded_by: null,
      }),
      taxonomy,
    );
    expect(result.ok).toBe(true);
  });

  it("allows transfer with no funding source", () => {
    const result = validateExtraction(
      expense({
        type: "transfer",
        amount: "50.00",
        items: [],
        to_account: "Rainy-day fund",
        merchant: null,
        venue: null,
        tags: [],
        funded_by: null,
      }),
      taxonomy,
    );
    expect(result.ok).toBe(true);
  });

  describe("transfer accounts", () => {
    const accounts = { ...taxonomy, accounts: ["Rainy-day fund", "Retirement"] };
    const move = (from_account: string | null, to_account: string | null) =>
      expense({
        type: "transfer",
        amount: "50.00",
        items: [],
        from_account,
        to_account,
        merchant: null,
        venue: null,
        tags: [],
        funded_by: null,
      });

    it.each([
      ["a deposit (to only)", null, "Rainy-day fund"],
      ["a withdrawal (from only)", "Rainy-day fund", null],
      ["a move between two accounts", "Rainy-day fund", "Retirement"],
    ])("accepts a transfer that is %s", (_name, from, to) => {
      expect(validateExtraction(move(from, to), accounts)).toMatchObject({ ok: true, errors: [] });
    });

    it.each([
      ["no account on either side", null, null, "transfer requires from_account or to_account"],
      ["an unknown from account", "Vacation", null, "unknown account: Vacation"],
      ["an unknown to account", "Rainy-day fund", "Vacation", "unknown account: Vacation"],
      [
        "the same account on both sides",
        "Rainy-day fund",
        "Rainy-day fund",
        "transfer from and to the same account: Rainy-day fund",
      ],
    ])("rejects a transfer with %s", (_name, from, to, error) => {
      expect(validateExtraction(move(from, to), accounts)).toMatchObject({
        ok: false,
        errors: [error],
      });
    });
  });
});

describe("normalizeTaxonomyNames", () => {
  it("strips a repeated category prefix from subcategory and item_type", () => {
    const prefixed = expense({
      amount: "12.50",
      items: [
        {
          description: "Lunch",
          amount: "12.50",
          category: "Food and drink",
          subcategory: "Food and drink / Takeout / Quick Service",
          item_type: "Food and drink / Meals & Prepared Food",
          bucket: "wants",
        },
      ],
    });
    expect(validateExtraction(prefixed, taxonomy).ok).toBe(false);

    const normalized = normalizeTaxonomyNames(prefixed, taxonomy);
    expect(normalized.items[0].subcategory).toBe("Takeout / Quick Service");
    expect(normalized.items[0].item_type).toBe("Meals & Prepared Food");
    expect(validateExtraction(normalized, taxonomy).ok).toBe(true);
  });

  it("keeps a line tag on that line only, without repeats or a header tag", () => {
    const [burger, coke] = expense().items;
    const tagged = expense({
      tags: ["Social"],
      items: [{ ...burger, tags: ["Travel", "Social", "Travel"] }, coke],
    });
    const normalized = normalizeTaxonomyNames(tagged, taxonomy);
    expect(normalized.tags).toEqual(["Social"]);
    expect(normalized.items.map((i) => i.tags)).toEqual([["Travel"], []]);
    expect(normalizeTaxonomyNames(normalized, taxonomy)).toEqual(normalized);
  });

  it("drops a line tag missing from the Tags list, even on every line, and warns instead of blocking", () => {
    const [burger, coke] = expense().items;
    const unknown = expense({
      tags: [],
      items: [{ ...burger, tags: ["NotATag", "Travel"] }, { ...coke, tags: ["NotATag"] }],
    });
    const normalized = normalizeTaxonomyNames(unknown, taxonomy);
    expect(normalized.tags).toEqual([]);
    expect(normalized.items.map((i) => i.tags)).toEqual([["Travel"], []]);
    expect(normalizeTaxonomyNames(normalized, taxonomy)).toEqual(normalized);

    const checks = validateExtraction(normalized, taxonomy);
    expect(checks.ok).toBe(true);
    expect(checks.warnings).toEqual([
      'tag "NotATag" is not in lookup; "Burger combo" will save without it',
      'tag "NotATag" is not in lookup; "Coke" will save without it',
    ]);
  });

  it("moves a tag that every line carries to the header", () => {
    const [burger, coke] = expense().items;
    const everyLine = expense({
      tags: [],
      items: [{ ...burger, tags: ["Travel", "Social"] }, { ...coke, tags: ["Travel"] }],
    });
    const normalized = normalizeTaxonomyNames(everyLine, taxonomy);
    expect(normalized.tags).toEqual(["Travel"]);
    expect(normalized.items.map((i) => i.tags)).toEqual([["Social"], []]);
  });

  it("keeps income and transfer tags on the header, once each", () => {
    const pay = expense({ type: "income", tags: ["Social", "Social"], items: [] });
    expect(normalizeTaxonomyNames(pay, taxonomy).tags).toEqual(["Social"]);
  });
});

describe("formatPreview", () => {
  it("shows a line's own tags under that line only", () => {
    const [burger, coke] = expense().items;
    const e = expense({ items: [burger, { ...coke, tags: ["Travel"] }] });
    const lines = formatPreview(e, validateExtraction(e, taxonomy)).split("\n");
    const coke_ = lines.indexOf("• Coke — 8.05");
    expect(lines.slice(coke_, coke_ + 3)).toEqual([
      "• Coke — 8.05",
      "  Food and drink / Takeout / Quick Service / Non-Alcoholic Beverages / wants",
      "  Tags: Travel",
    ]);
    expect(lines.filter((l) => l.includes("Tags:"))).toEqual(["Tags: Social", "  Tags: Travel"]);
  });

  it("shows header fields, tags, every line, and check results", () => {
    const checks = validateExtraction(expense(), taxonomy);
    const text = formatPreview(expense(), checks);
    expect(text).toContain("Expense");
    expect(text).toContain("CAD 27.60");
    expect(text).toContain("McDonald's");
    expect(text).toContain("Fast Food");
    expect(text).toContain("Social");
    expect(text).toContain("self");
    expect(text).toContain("Burger combo");
    expect(text).toContain("19.55");
    expect(text).toContain("Takeout / Quick Service");
    expect(text).toContain("wants");
    expect(text).toMatch(/✓.*27\.60/);
  });

  it("labels the header (i of n) only when a message has several events", () => {
    const e = expense();
    const checks = validateExtraction(e, taxonomy);
    expect(formatPreview(e, checks, { index: 1, count: 2 }).split("\n")[0]).toBe(
      "Expense · 2026-08-17 · CAD 27.60 (2 of 2)",
    );
    expect(formatPreview(e, checks, { index: 0, count: 1 }).split("\n")[0]).toBe(
      "Expense · 2026-08-17 · CAD 27.60",
    );
    expect(formatPreview(e, checks).split("\n")[0]).toBe("Expense · 2026-08-17 · CAD 27.60");
  });

  it("shows a merchant hint after the warnings and before the Confirm line", () => {
    const e = expense();
    const checks = { ...validateExtraction(e, taxonomy), warnings: ["Possible duplicate: x"] };
    const lines = formatPreview(e, checks, undefined, "Try this.").split("\n");
    expect(lines.indexOf("💡 Try this.")).toBe(lines.indexOf("! Possible duplicate: x") + 1);
    expect(lines.indexOf("💡 Try this.")).toBeLessThan(lines.indexOf("Confirm to save · Discard to drop"));
    expect(formatPreview(e, checks)).not.toContain("💡");
  });

  it("adds the card's (k of n) to an ack only when its header carries one", () => {
    const header = "Expense · 2026-08-17 · CAD 27.60";
    expect(withPosition("Saved.", `${header} (2 of 3)\nBurger`)).toBe("Saved. (2 of 3)");
    expect(withPosition("Discarded.", `${header} (1 of 2)`)).toBe("Discarded. (1 of 2)");
    expect(withPosition("Saved.", `${header}\nBurger (2 of 3)`)).toBe("Saved.");
    expect(withPosition("Saved.", header)).toBe("Saved.");
    expect(withPosition("Saved.", undefined)).toBe("Saved.");
  });

  it("shows the note under the description, and no Note line without one", () => {
    const noted = expense({ notes: "too lazy to cook" });
    const text = formatPreview(noted, validateExtraction(noted, taxonomy));
    const lines = text.split("\n");
    expect(lines[2]).toBe("Note: too lazy to cook");

    expect(formatPreview(expense(), validateExtraction(expense(), taxonomy))).not.toMatch(/Note:/);
  });

  it("flags a card that a Lite model read, and only then", () => {
    const meta = {
      model: "gemini-3.6-flash",
      extractor_sha256: "a",
      taxonomy_sha256: "b",
    };
    const render = (m: Extraction["meta"]) => {
      const e = expense({ meta: m });
      return formatPreview(e, validateExtraction(e, taxonomy));
    };

    expect(render(meta)).not.toMatch(/lighter model/i);
    expect(render({ ...meta, bucket_model: "gemini-3.5-flash" })).not.toMatch(/lighter model/i);
    expect(render({ ...meta, model: "gemini-3.5-flash-lite" })).toMatch(
      /! read by a lighter model while Gemini was busy — check categories and buckets/,
    );
    expect(render({ ...meta, bucket_model: "gemini-3.5-flash-lite" })).toMatch(/lighter model/i);
  });

  it("omits a confirm hint when checks fail", () => {
    const bad = expense({ amount: "99.00" });
    const checks = validateExtraction(bad, taxonomy);
    const text = formatPreview(bad, checks);
    expect(text).toContain("✗");
    expect(text).not.toMatch(/Confirm to save/i);
  });

  it("omits Funded by on income even when extraction still has a leftover value", () => {
    const pay = expense({
      type: "income",
      amount: "2000.00",
      items: [],
      income_source: "Salary",
      merchant: null,
      venue: null,
      tags: [],
    });
    const text = formatPreview(pay, validateExtraction(pay, taxonomy));
    expect(text).toContain("Income source: Salary");
    expect(text).not.toMatch(/Funded by/i);
  });

  it("omits Funded by on transfer", () => {
    const move = expense({
      type: "transfer",
      amount: "50.00",
      items: [],
      to_account: "Rainy-day fund",
      merchant: null,
      venue: null,
      tags: [],
    });
    const text = formatPreview(move, validateExtraction(move, taxonomy));
    expect(text).toContain("To account: Rainy-day fund");
    expect(text).not.toMatch(/Funded by/i);
    expect(text).not.toMatch(/From account/);
  });

  it.each([
    ["a withdrawal names chequing as where it goes", "Rainy-day fund", null, "From account: Rainy-day fund\nTo account: chequing"],
    ["a move names both accounts", "Rainy-day fund", "Retirement", "From account: Rainy-day fund\nTo account: Retirement"],
  ])("shows the account a transfer leaves: %s", (_name, from_account, to_account, shown) => {
    const move = expense({
      type: "transfer",
      amount: "200.00",
      items: [],
      from_account,
      to_account,
      merchant: null,
      venue: null,
      tags: [],
    });
    const accounts = { ...taxonomy, accounts: ["Rainy-day fund", "Retirement"] };
    const text = formatPreview(move, validateExtraction(move, accounts));
    expect(text).toContain(shown);
    expect(text).toContain("Confirm to save");
  });
});

describe("fundingSourceToPersist", () => {
  it("keeps the name on expenses and drops it otherwise", () => {
    expect(fundingSourceToPersist("expense", "self")).toBe("self");
    expect(fundingSourceToPersist("income", "self")).toBeNull();
    expect(fundingSourceToPersist("transfer", "Example Funder")).toBeNull();
    expect(fundingSourceToPersist("income", null)).toBeNull();
  });
});

describe("merchantHint", () => {
  it("names the merchant, the count and the command to send", () => {
    expect(merchantHint({ name: "Maple Kiosk", count: 4 })).toBe(
      "You've bought from Maple Kiosk 4 times. Send /addmerchant Maple Kiosk to track it.",
    );
  });

  it("says nothing without a frequent merchant, or for a name /addmerchant would refuse", () => {
    expect(merchantHint(null)).toBeUndefined();
    expect(merchantHint({ name: "Shop, Inc", count: 4 })).toBeUndefined();
    expect(merchantHint({ name: "x".repeat(101), count: 4 })).toBeUndefined();
  });
});

describe("duplicateWarnings", () => {
  const saved = {
    rule: "amount",
    status: "saved",
    date: "2026-10-25",
    amount: "23.47",
    description: "Big Box Market groceries",
  } as const;

  it("is empty when nothing matches", () => {
    expect(duplicateWarnings([])).toEqual([]);
  });

  it("names the nearest amount match, saved or still pending, and counts the rest", () => {
    expect(duplicateWarnings([saved])).toEqual([
      'Possible duplicate: CAD 23.47 on 2026-10-25, "Big Box Market groceries" (saved)',
    ]);
    expect(
      duplicateWarnings([
        { ...saved, status: "pending", date: "2026-10-27", amount: "12.50", description: "Lunch" },
        saved,
      ]),
    ).toEqual(['Possible duplicate: CAD 12.50 on 2026-10-27, "Lunch" (still pending) (+1 more)']);
  });

  it("shows only the photo match when there is one", () => {
    expect(
      duplicateWarnings([{ ...saved, rule: "photo", date: "2026-10-26" }, saved, saved]),
    ).toEqual(["Same photo as a card from 2026-10-26 (saved)"]);
  });
});
