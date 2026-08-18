import { describe, expect, it } from "vitest";
import {
  formatPreview,
  mergeBuckets,
  normalizeTaxonomyNames,
  parseCents,
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
  accounts: ["Emergency Fund"],
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

  it("allows an unknown merchant (nullable FK)", () => {
    const result = validateExtraction(
      expense({ merchant: "New Cafe" }),
      taxonomy,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /merchant/i.test(w))).toBe(true);
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
});

describe("mergeBuckets", () => {
  it("assigns buckets by item index without changing amounts", () => {
    const extracted = expense({
      items: expense().items.map(({ bucket: _b, ...item }) => ({
        ...item,
        bucket: "needs" as const,
      })),
    });
    // Simulate extractor output by overwriting after merge input type — merge
    // takes items that may omit a final bucket.
    const merged = mergeBuckets(extracted, [
      { bucket: "wants", why: "takeout is discretionary" },
      { bucket: "wants", why: "soft drink" },
    ]);
    expect(merged.items[0].bucket).toBe("wants");
    expect(merged.items[0].bucket_why).toBe("takeout is discretionary");
    expect(merged.items[1].amount).toBe("8.05");
  });
});

describe("formatPreview", () => {
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

  it("omits a confirm hint when checks fail", () => {
    const bad = expense({ amount: "99.00" });
    const checks = validateExtraction(bad, taxonomy);
    const text = formatPreview(bad, checks);
    expect(text).toContain("✗");
    expect(text).not.toMatch(/Confirm to save/i);
  });
});
