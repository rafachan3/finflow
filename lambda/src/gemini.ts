import {
  mergeBuckets,
  normalizeTaxonomyNames,
  type Bucket,
  type Extraction,
  type ExtractionItem,
  type TaxonomySnapshot,
  type TokenUsage,
  type TxType,
} from "./extraction.js";

export const GEMINI_MODEL = "gemini-3.6-flash";

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ITEM_PROPERTIES = {
  description: { type: "STRING" },
  amount: { type: "STRING" },
  category: { type: "STRING" },
  subcategory: { type: "STRING" },
  item_type: { type: "STRING", nullable: true },
};

const EXTRACTOR_SCHEMA = {
  type: "OBJECT",
  properties: {
    type: { type: "STRING", enum: ["income", "expense", "transfer"] },
    amount: { type: "STRING" },
    currency: { type: "STRING" },
    date: { type: "STRING" },
    description: { type: "STRING" },
    merchant: { type: "STRING", nullable: true },
    venue: { type: "STRING", nullable: true },
    tags: { type: "ARRAY", items: { type: "STRING" } },
    funded_by: { type: "STRING" },
    is_recurring: { type: "BOOLEAN" },
    income_source: { type: "STRING", nullable: true },
    to_account: { type: "STRING", nullable: true },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: ITEM_PROPERTIES,
        required: [
          "description",
          "amount",
          "category",
          "subcategory",
          "item_type",
        ],
      },
    },
    confidence: { type: "NUMBER" },
  },
  required: [
    "type",
    "amount",
    "currency",
    "date",
    "description",
    "merchant",
    "venue",
    "tags",
    "funded_by",
    "is_recurring",
    "income_source",
    "to_account",
    "items",
    "confidence",
  ],
};

const BUCKET_SCHEMA = {
  type: "OBJECT",
  properties: {
    buckets: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          bucket: { type: "STRING", enum: ["needs", "wants"] },
          why: { type: "STRING" },
        },
        required: ["bucket", "why"],
      },
    },
  },
  required: ["buckets"],
};

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};

async function generateJson(args: {
  apiKey: string;
  system: string;
  user: string;
  schema: object;
}): Promise<{ data: unknown; usage: TokenUsage }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": args.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: [{ role: "user", parts: [{ text: args.user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: args.schema,
      },
    }),
  });
  const body = (await res.json()) as GeminiResponse;
  if (!res.ok) {
    throw new Error(
      `Gemini HTTP ${res.status}${body.error?.message ? `: ${body.error.message}` : ""}`,
    );
  }
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no JSON text");
  }
  return {
    data: JSON.parse(text) as unknown,
    usage: {
      input: body.usageMetadata?.promptTokenCount ?? 0,
      output: body.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

function taxonomyPrompt(taxonomy: TaxonomySnapshot): string {
  const subs = taxonomy.subcategories
    .map(
      (s) =>
        `- ${s.category} / ${s.name}` +
        (s.default_bucket ? ` (hint ${s.default_bucket})` : ""),
    )
    .join("\n");
  const types = taxonomy.itemTypes
    .map((t) => `- ${t.category} / ${t.name}`)
    .join("\n");
  return [
    "Classify using ONLY these names.",
    "Subcategories:",
    subs,
    "Item types (null if the category has none, or if none fits):",
    types || "(none)",
    `Venues: ${taxonomy.venues.join(", ") || "(none)"}`,
    `Tags: ${taxonomy.tags.join(", ") || "(none)"}`,
    `Funding: ${taxonomy.fundingSources.join(", ")}`,
    `Merchants: ${taxonomy.merchants.join(", ") || "(none)"}`,
    `Income sources: ${taxonomy.incomeSources.join(", ") || "(none)"}`,
    `Accounts: ${taxonomy.accounts.join(", ") || "(none)"}`,
  ].join("\n");
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

function asItem(raw: unknown): Omit<ExtractionItem, "bucket" | "bucket_why"> {
  const o = raw as Record<string, unknown>;
  return {
    description: String(o.description ?? ""),
    amount: String(o.amount ?? ""),
    category: String(o.category ?? ""),
    subcategory: String(o.subcategory ?? ""),
    item_type: asString(o.item_type),
  };
}

function asExtraction(raw: unknown): Extraction {
  const o = raw as Record<string, unknown>;
  const items = Array.isArray(o.items) ? o.items.map(asItem) : [];
  return {
    type: o.type as TxType,
    amount: String(o.amount ?? ""),
    currency: "CAD",
    date: String(o.date ?? ""),
    description: String(o.description ?? ""),
    merchant: asString(o.merchant),
    venue: asString(o.venue),
    tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    funded_by: String(o.funded_by ?? "self"),
    is_recurring: Boolean(o.is_recurring),
    income_source: asString(o.income_source),
    to_account: asString(o.to_account),
    items: items.map((item) => ({ ...item, bucket: "wants" as Bucket })),
    confidence: typeof o.confidence === "number" ? o.confidence : 0,
  };
}

export async function extractFromText(args: {
  apiKey: string;
  text: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
}): Promise<Extraction> {
  const extractor = await generateJson({
    apiKey: args.apiKey,
    schema: EXTRACTOR_SCHEMA,
    system: [
      "You extract Canadian personal-finance transactions from a short text.",
      `Today is ${args.today} (America/Toronto). Currency is CAD.`,
      "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
      "Do not assign needs/wants. Item types must belong to the same category as the subcategory.",
      "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
      "Use Other … subcategories only when nothing more specific fits.",
      taxonomyPrompt(args.taxonomy),
    ].join("\n"),
    user: args.text,
  });

  const extraction = normalizeTaxonomyNames(
    asExtraction(extractor.data),
    args.taxonomy,
  );
  extraction.usage = { extractor: extractor.usage };

  if (extraction.type !== "expense" || extraction.items.length === 0) {
    return extraction;
  }

  const rules =
    args.bucketRules.trim() ||
    "No personal rules. Use subcategory default_bucket hints. If null or context is missing, assign wants.";

  const bucketRes = await generateJson({
    apiKey: args.apiKey,
    schema: BUCKET_SCHEMA,
    system: [
      "You assign needs or wants to each expense line.",
      "Apply these rules. They override default_bucket hints.",
      rules,
    ].join("\n\n"),
    user: JSON.stringify(
      extraction.items.map((item, index) => ({
        index,
        description: item.description,
        amount: item.amount,
        category: item.category,
        subcategory: item.subcategory,
        item_type: item.item_type,
        tags: extraction.tags,
        merchant: extraction.merchant,
        venue: extraction.venue,
      })),
    ),
  });

  const parsed = bucketRes.data as {
    buckets?: { bucket: Bucket; why?: string }[];
  };
  const buckets = parsed.buckets ?? [];
  const merged = mergeBuckets(extraction, buckets);
  merged.usage = {
    extractor: extractor.usage,
    bucket: bucketRes.usage,
  };
  return merged;
}
