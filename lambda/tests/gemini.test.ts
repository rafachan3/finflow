import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFromText } from "../src/gemini.js";
import type { TaxonomySnapshot } from "../src/extraction.js";

const taxonomy: TaxonomySnapshot = {
  subcategories: [
    {
      category: "Food and drink",
      name: "Takeout / Quick Service",
      default_bucket: "wants",
    },
  ],
  itemTypes: [
    { category: "Food and drink", name: "Meals & Prepared Food" },
  ],
  venues: ["Fast Food"],
  tags: ["Social"],
  fundingSources: ["self"],
  merchants: ["Chipotle"],
  incomeSources: [],
  accounts: [],
};

function geminiJson(payload: unknown, input = 10, output = 5) {
  return {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(payload) }] },
      },
    ],
    usageMetadata: { promptTokenCount: input, candidatesTokenCount: output },
  };
}

const extracted = {
  type: "expense",
  amount: "12.50",
  currency: "CAD",
  date: "2026-08-17",
  description: "chipotle lunch",
  merchant: "Chipotle",
  venue: "Fast Food",
  tags: ["Social"],
  funded_by: "self",
  is_recurring: false,
  income_source: null,
  to_account: null,
  items: [
    {
      description: "burrito",
      amount: "12.50",
      category: "Food and drink",
      subcategory: "Takeout / Quick Service",
      item_type: "Meals & Prepared Food",
    },
  ],
  confidence: 0.8,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractFromText", () => {
  it("calls extractor then bucket specialist and merges buckets", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geminiJson(extracted, 100, 40),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson(
            { buckets: [{ bucket: "wants", why: "takeout" }] },
            50,
            10,
          ),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractFromText({
      apiKey: "test-key",
      text: "12.50 lunch chipotle",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-17",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(
      fetchMock.mock.calls[0][1].body as string,
    ) as { generationConfig: { responseSchema: { properties: { items: { items: { properties: Record<string, unknown> } } } } } };
    expect(firstBody.generationConfig.responseSchema.properties.items.items.properties.bucket).toBeUndefined();

    const secondUser = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      contents: { parts: { text: string }[] }[];
    };
    expect(secondUser.contents[0].parts[0].text).toContain("burrito");
    expect(secondUser.contents[0].parts[0].text).not.toContain("12.50 lunch chipotle");

    expect(result.items[0].bucket).toBe("wants");
    expect(result.items[0].bucket_why).toBe("takeout");
    expect(result.usage?.extractor).toEqual({ input: 100, output: 40 });
    expect(result.usage?.bucket).toEqual({ input: 50, output: 10 });
  });

  it("skips the bucket call for income", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () =>
        geminiJson({
          ...extracted,
          type: "income",
          amount: "2000.00",
          items: [],
          income_source: "Salary",
          merchant: null,
          venue: null,
          tags: [],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractFromText({
      apiKey: "test-key",
      text: "got paid 2000 salary",
      taxonomy,
      bucketRules: "unused",
      today: "2026-08-17",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.items).toEqual([]);
    expect(result.type).toBe("income");
  });

  it("sends the API key in a header, not the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        geminiJson({
          ...extracted,
          type: "income",
          items: [],
          income_source: "Salary",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await extractFromText({
      apiKey: "secret-key",
      text: "got paid",
      taxonomy,
      bucketRules: "",
      today: "2026-08-17",
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("gemini-3.6-flash");
    expect(url).not.toContain("secret-key");
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("secret-key");
  });
});
