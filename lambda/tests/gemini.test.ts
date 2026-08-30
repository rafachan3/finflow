import { afterEach, describe, expect, it, vi } from "vitest";
import { extractFromPhoto, extractFromText, extractFromVoice } from "../src/gemini.js";
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
    expect(result.meta?.model).toBe("gemini-3.6-flash");
    expect(result.meta?.extractor_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta?.taxonomy_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta?.bucket_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta?.rules_sha256).toMatch(/^[0-9a-f]{64}$/);

    const firstSystem = JSON.parse(
      fetchMock.mock.calls[0][1].body as string,
    ) as { systemInstruction: { parts: { text: string }[] } };
    expect(firstSystem.systemInstruction.parts[0].text).toMatch(
      /empty string/i,
    );
    expect(firstSystem.systemInstruction.parts[0].text).toMatch(
      /never guess/i,
    );
    expect(firstSystem.systemInstruction.parts[0].text).toMatch(
      /ordinary English/i,
    );
    expect(firstSystem.systemInstruction.parts[0].text).toMatch(
      /Translate French/i,
    );
    expect(firstSystem.systemInstruction.parts[0].text).toMatch(
      /Keep brand names/i,
    );
  });

  it("hashes prompt text, not today's date, and splits taxonomy from rules", async () => {
    const mockPair = () =>
      vi
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

    const run = async (
      fetchMock: ReturnType<typeof vi.fn>,
      extra: Partial<{
        today: string;
        bucketRules: string;
        taxonomy: TaxonomySnapshot;
      }>,
    ) => {
      vi.stubGlobal("fetch", fetchMock);
      return extractFromText({
        apiKey: "test-key",
        text: "12.50 lunch chipotle",
        taxonomy: extra.taxonomy ?? taxonomy,
        bucketRules: extra.bucketRules ?? "Takeout is wants.",
        today: extra.today ?? "2026-08-17",
      });
    };

    const a = await run(mockPair(), { today: "2026-08-17" });
    vi.unstubAllGlobals();
    const b = await run(mockPair(), { today: "2026-08-18" });
    vi.unstubAllGlobals();
    const c = await run(mockPair(), { bucketRules: "Takeout is needs." });
    vi.unstubAllGlobals();
    const d = await run(mockPair(), {
      taxonomy: { ...taxonomy, merchants: ["Chipotle", "McDonald's"] },
    });

    expect(a.meta?.extractor_sha256).toBe(b.meta?.extractor_sha256);
    expect(a.meta?.taxonomy_sha256).toBe(b.meta?.taxonomy_sha256);
    expect(a.meta?.rules_sha256).not.toBe(c.meta?.rules_sha256);
    expect(a.meta?.extractor_sha256).toBe(c.meta?.extractor_sha256);
    expect(a.meta?.taxonomy_sha256).not.toBe(d.meta?.taxonomy_sha256);
    expect(a.meta?.extractor_sha256).toBe(d.meta?.extractor_sha256);
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
    expect(result.meta?.model).toBe("gemini-3.6-flash");
    expect(result.meta?.extractor_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta?.taxonomy_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta?.bucket_sha256).toBeUndefined();
    expect(result.meta?.rules_sha256).toBeUndefined();
  });

  it("keeps funded_by null when Gemini returns null", async () => {
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
          funded_by: null,
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

    expect(result.funded_by).toBeNull();
  });

  it("defaults expense funded_by to self when Gemini returns null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({
            ...extracted,
            funded_by: null,
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ buckets: [{ bucket: "wants", why: "takeout" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractFromText({
      apiKey: "test-key",
      text: "12.50 lunch chipotle",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-17",
    });

    expect(result.type).toBe("expense");
    expect(result.funded_by).toBe("self");
  });

  it("asks Gemini for nullable funded_by, expense-only", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        geminiJson({
          ...extracted,
          type: "income",
          items: [],
          income_source: "Salary",
          funded_by: null,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await extractFromText({
      apiKey: "test-key",
      text: "got paid",
      taxonomy,
      bucketRules: "",
      today: "2026-08-17",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      systemInstruction: { parts: { text: string }[] };
      generationConfig: {
        responseSchema: {
          properties: { funded_by: { nullable?: boolean } };
          required: string[];
        };
      };
    };
    expect(body.generationConfig.responseSchema.properties.funded_by.nullable).toBe(
      true,
    );
    expect(body.generationConfig.responseSchema.required).not.toContain(
      "funded_by",
    );
    expect(body.systemInstruction.parts[0].text).toMatch(
      /funded_by is who paid for an expense/i,
    );
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

describe("extractFromPhoto", () => {
  it("sends JPEG inline data plus caption, then the bucket specialist without the image", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
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

    const result = await extractFromPhoto({
      apiKey: "test-key",
      image: jpeg,
      mimeType: "image/jpeg",
      caption: "yesterday with Sofya",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-17",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      systemInstruction: { parts: { text: string }[] };
      contents: {
        parts: { text?: string; inlineData?: { mimeType: string; data: string } }[];
      }[];
    };
    const parts = first.contents[0].parts;
    const inline = parts.find((p) => p.inlineData);
    expect(inline?.inlineData).toEqual({
      mimeType: "image/jpeg",
      data: jpeg.toString("base64"),
    });
    expect(parts.some((p) => p.text?.includes("yesterday with Sofya"))).toBe(
      true,
    );
    expect(first.systemInstruction.parts[0].text).toMatch(/receipt/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/never guess/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/empty string/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/ordinary English/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/Translate French/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/Keep brand names/i);

    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      contents: { parts: { text?: string; inlineData?: unknown }[] }[];
    };
    expect(JSON.stringify(second.contents)).not.toContain(
      jpeg.toString("base64"),
    );
    expect(result.items[0].bucket).toBe("wants");
    expect(result.meta?.extractor_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a receipt instruction when the caption is empty", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
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

    await extractFromPhoto({
      apiKey: "test-key",
      image: jpeg,
      mimeType: "image/jpeg",
      caption: "  ",
      taxonomy,
      bucketRules: "",
      today: "2026-08-17",
    });

    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      contents: { parts: { text?: string }[] }[];
    };
    const text = first.contents[0].parts.find((p) => p.text)?.text ?? "";
    expect(text).toMatch(/receipt/i);
  });
});

describe("extractFromVoice", () => {
  it("sends Ogg inline data plus caption, then the bucket specialist without the audio", async () => {
    const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
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

    const result = await extractFromVoice({
      apiKey: "test-key",
      audio: ogg,
      mimeType: "audio/ogg",
      caption: "yesterday",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-17",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      systemInstruction: { parts: { text: string }[] };
      contents: {
        parts: { text?: string; inlineData?: { mimeType: string; data: string } }[];
      }[];
    };
    const parts = first.contents[0].parts;
    const inline = parts.find((p) => p.inlineData);
    expect(inline?.inlineData).toEqual({
      mimeType: "audio/ogg",
      data: ogg.toString("base64"),
    });
    expect(parts.some((p) => p.text?.includes("yesterday"))).toBe(true);
    expect(first.systemInstruction.parts[0].text).toMatch(/voice note/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/never guess/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/empty string/i);
    expect(first.systemInstruction.parts[0].text).not.toMatch(/receipt photo/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/ordinary English/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/Translate French/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/Keep brand names/i);

    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      contents: { parts: { text?: string; inlineData?: unknown }[] }[];
    };
    expect(JSON.stringify(second.contents)).not.toContain(
      ogg.toString("base64"),
    );
    expect(result.items[0].bucket).toBe("wants");
    expect(result.meta?.extractor_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses a voice-note instruction when the caption is empty", async () => {
    const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53]);
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

    await extractFromVoice({
      apiKey: "test-key",
      audio: ogg,
      mimeType: "audio/ogg",
      caption: "  ",
      taxonomy,
      bucketRules: "",
      today: "2026-08-17",
    });

    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      contents: { parts: { text?: string }[] }[];
    };
    const text = first.contents[0].parts.find((p) => p.text)?.text ?? "";
    expect(text).toMatch(/voice/i);
  });
});
