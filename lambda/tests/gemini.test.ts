import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFromPhoto,
  extractFromText,
  extractFromVoice,
  patchExtraction,
} from "../src/gemini.js";
import type { Extraction, TaxonomySnapshot } from "../src/extraction.js";

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
    expect(result.meta?.bucket_model).toBe("gemini-3.6-flash");
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

  it("asks Gemini for a nullable note in the owner's words", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ ...extracted, notes: "too lazy to cook" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ buckets: [{ bucket: "wants", why: "takeout" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractFromText({
      apiKey: "test-key",
      text: "13.50 indian on uber eats, too lazy to cook",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-17",
    });

    expect(result.notes).toBe("too lazy to cook");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      systemInstruction: { parts: { text: string }[] };
      generationConfig: {
        responseSchema: {
          properties: { notes: { nullable?: boolean } };
          required: string[];
        };
      };
    };
    expect(body.generationConfig.responseSchema.properties.notes.nullable).toBe(
      true,
    );
    expect(body.generationConfig.responseSchema.required).not.toContain("notes");
    expect(body.systemInstruction.parts[0].text).toMatch(/notes is the owner's reason/i);
    expect(body.systemInstruction.parts[0].text).toMatch(/never from printed receipt text/i);
  });

  it("returns null notes when Gemini omits or empties them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geminiJson({ ...extracted, notes: "" }),
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

    expect(result.notes).toBeNull();
  });

  describe("transient Gemini errors", () => {
    const incomeJson = {
      ...extracted,
      type: "income",
      amount: "2000.00",
      items: [],
      income_source: "Salary",
      funded_by: null,
    };
    const overloaded = (status = 503) => ({
      ok: false,
      status,
      json: async () => ({ error: { message: "high demand" } }),
    });
    const run = async () => {
      const p = extractFromText({
        apiKey: "test-key",
        text: "got paid",
        taxonomy,
        bucketRules: "",
        today: "2026-08-17",
      });
      const settled = p.then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
      await vi.runAllTimersAsync();
      return settled;
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const modelOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
      String(fetchMock.mock.calls[call][0]).match(/models\/([^:]+):/)?.[1];

    it("retries a 503 on the fallback model and records which model answered", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(overloaded())
        .mockResolvedValueOnce({ ok: true, json: async () => geminiJson(incomeJson) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await run();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(modelOf(fetchMock, 0)).toBe("gemini-3.6-flash");
      expect(modelOf(fetchMock, 1)).toBe("gemini-3.5-flash");
      expect("value" in result && result.value.amount).toBe("2000.00");
      expect("value" in result && result.value.meta?.model).toBe("gemini-3.5-flash");
    });

    it("records the bucket step's model separately when only it falls back", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => geminiJson(extracted) })
        .mockResolvedValueOnce(overloaded())
        .mockResolvedValueOnce({
          ok: true,
          json: async () => geminiJson({ buckets: [{ bucket: "wants", why: "takeout" }] }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const p = extractFromText({
        apiKey: "test-key",
        text: "12.50 lunch chipotle",
        taxonomy,
        bucketRules: "Takeout is wants.",
        today: "2026-08-17",
      });
      await vi.runAllTimersAsync();
      const result = await p;

      expect(result.meta?.model).toBe("gemini-3.6-flash");
      expect(result.meta?.bucket_model).toBe("gemini-3.5-flash");
    });

    it("retries a non-JSON 503 body too", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        })
        .mockResolvedValueOnce({ ok: true, json: async () => geminiJson(incomeJson) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await run();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect("value" in result).toBe(true);
    });

    it("gives up after three attempts with the HTTP status in the error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(overloaded(503));
      vi.stubGlobal("fetch", fetchMock);

      const result = await run();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect([0, 1, 2].map((i) => modelOf(fetchMock, i))).toEqual([
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash",
      ]);
      expect("error" in result && result.error.message).toMatch(/Gemini HTTP 503/);
    });

    it("does not retry a 429 quota error", async () => {
      const fetchMock = vi.fn().mockResolvedValue(overloaded(429));
      vi.stubGlobal("fetch", fetchMock);

      const result = await run();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect("error" in result && result.error.message).toMatch(/Gemini HTTP 429/);
    });
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
      caption: "yesterday with a friend",
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
    expect(parts.some((p) => p.text?.includes("yesterday with a friend"))).toBe(
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

const current = {
  ...extracted,
  currency: "CAD" as const,
  date_source: "stated" as const,
  items: [
    {
      ...extracted.items[0],
      bucket: "wants" as const,
      bucket_why: "takeout",
    },
  ],
  usage: { extractor: { input: 9, output: 3 } },
  meta: {
    model: "gemini-3.6-flash",
    extractor_sha256: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111",
    taxonomy_sha256: "2222222233333333444444445555555566666666777777778888888899999999",
  },
} as Extraction;

describe("patchExtraction", () => {
  it("sends the current extraction and correction, then the bucket specialist, with no media", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ ...extracted, amount: "14.50", items: [{ ...extracted.items[0], amount: "14.50" }] }, 80, 20),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ buckets: [{ bucket: "wants", why: "takeout" }] }, 40, 8),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchExtraction({
      apiKey: "test-key",
      current,
      correction: "14.50",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-30",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      systemInstruction: { parts: { text: string }[] };
      contents: {
        parts: { text?: string; inlineData?: unknown }[];
      }[];
    };
    const blob = JSON.stringify(first.contents[0].parts);
    expect(blob).toContain("chipotle lunch");
    expect(blob).toContain("burrito");
    expect(blob).toContain("14.50");
    expect(blob).not.toContain("aaaaaaaa");
    expect(blob).not.toContain("takeout");
    expect(blob).not.toContain("inlineData");
    expect(first.systemInstruction.parts[0].text).toMatch(/correction/i);
    expect(first.systemInstruction.parts[0].text).toMatch(/Keep every field/i);
    expect(first.systemInstruction.parts[0].text).not.toMatch(/receipt photo/i);

    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      contents: { parts: { text?: string; inlineData?: unknown }[] }[];
    };
    expect(JSON.stringify(second.contents)).not.toContain("inlineData");
    expect(result.amount).toBe("14.50");
    expect(result.items[0].bucket).toBe("wants");
    expect(result.usage?.extractor).toEqual({ input: 80, output: 20 });
    expect(result.meta?.extractor_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.meta?.extractor_sha256).not.toBe(current.meta?.extractor_sha256);
  });

  it("keeps date_source when the date is unchanged", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geminiJson(extracted),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ buckets: [{ bucket: "wants", why: "takeout" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchExtraction({
      apiKey: "test-key",
      current,
      correction: "this is groceries",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-30",
    });

    expect(result.date).toBe("2026-08-17");
    expect(result.date_source).toBe("stated");
  });

  it("sets date_source to fix when the date changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => geminiJson({ ...extracted, date: "2026-08-16" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ buckets: [{ bucket: "wants", why: "takeout" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchExtraction({
      apiKey: "test-key",
      current,
      correction: "yesterday",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-30",
    });

    expect(result.date).toBe("2026-08-16");
    expect(result.date_source).toBe("fix");
  });

  it("sends the current note so a correction can keep or change it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ ...extracted, notes: "overslept, couldn't pack lunch" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          geminiJson({ buckets: [{ bucket: "wants", why: "takeout" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchExtraction({
      apiKey: "test-key",
      current: { ...current, notes: "overslept" },
      correction: "add that I couldn't pack lunch",
      taxonomy,
      bucketRules: "Takeout is wants.",
      today: "2026-08-30",
    });

    const blob = JSON.stringify(
      JSON.parse(fetchMock.mock.calls[0][1].body as string).contents,
    );
    expect(blob).toContain("overslept");
    expect(result.notes).toBe("overslept, couldn't pack lunch");
  });
});
