import { createHash } from "node:crypto";
import {
  mergeBuckets,
  normalizeTaxonomyNames,
  type Bucket,
  type Extraction,
  type ExtractionItem,
  type ExtractionMeta,
  type TaxonomySnapshot,
  type TokenUsage,
  type TxType,
} from "./extraction.js";

export const GEMINI_MODEL = "gemini-3.6-flash";

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ENGLISH_DESCRIPTIONS =
  "Header and line descriptions are ordinary English. Translate French and other languages from the receipt or message. Keep brand names. Do not add commentary.";

const FUNDED_BY =
  "funded_by is who paid for an expense. Set it only when type is expense. For income and transfer return null.";

const EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a short text.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
  "Do not assign needs/wants. Item types must belong to the same category as the subcategory.",
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  FUNDED_BY,
  "date is YYYY-MM-DD only when the user stated a calendar date (including today, yesterday, or a month and day). If they did not, return an empty string. Never guess today's date.",
].join("\n");

const PHOTO_EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a receipt photo.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
  "Do not assign needs/wants. Item types must belong to the same category as the subcategory.",
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  FUNDED_BY,
  "date is YYYY-MM-DD only when printed on the receipt or stated in the caption (including today, yesterday, or a month and day). If neither, return an empty string. Never guess today's date or the photo send time.",
].join("\n");

const VOICE_EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a voice note.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
  "Do not assign needs/wants. Item types must belong to the same category as the subcategory.",
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  FUNDED_BY,
  "date is YYYY-MM-DD only when the user stated a calendar date in the recording or caption (including today, yesterday, or a month and day). If they did not, return an empty string. Never guess today's date or the voice send time.",
].join("\n");

const PATCH_EXTRACTOR_STATIC_PROMPT = [
  "You apply a correction to an already extracted Canadian personal-finance transaction.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "The user message is the current extraction as JSON, then the correction.",
  "Keep every field the correction does not change.",
  "Keep date unless the correction changes the calendar date. Never guess today's date.",
  "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
  "Do not assign needs/wants. Item types must belong to the same category as the subcategory.",
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  FUNDED_BY,
].join("\n");

const BUCKET_STATIC_PROMPT = [
  "You assign needs or wants to each expense line.",
  "Apply these rules. They override default_bucket hints.",
].join("\n\n");

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function extractorSystem(
  today: string,
  taxonomy: TaxonomySnapshot,
  extractorStatic: string,
): string {
  return [
    extractorStatic.replace("YYYY-MM-DD", today),
    taxonomyPrompt(taxonomy),
  ].join("\n");
}

function promptMeta(
  taxonomy: TaxonomySnapshot,
  bucket?: { prompt: string; rules: string },
  extractorStatic: string = EXTRACTOR_STATIC_PROMPT,
): ExtractionMeta {
  const meta: ExtractionMeta = {
    model: GEMINI_MODEL,
    extractor_sha256: sha256Hex(extractorStatic),
    taxonomy_sha256: sha256Hex(taxonomyPrompt(taxonomy)),
  };
  if (bucket) {
    meta.bucket_sha256 = sha256Hex(bucket.prompt);
    meta.rules_sha256 = sha256Hex(bucket.rules);
  }
  return meta;
}

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
    funded_by: { type: "STRING", nullable: true },
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

type GeminiUserPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

async function generateJson(args: {
  apiKey: string;
  system: string;
  userParts: GeminiUserPart[];
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
      contents: [{ role: "user", parts: args.userParts }],
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
  const type = o.type as TxType;
  const fundedBy = asString(o.funded_by);
  return {
    type,
    amount: String(o.amount ?? ""),
    currency: "CAD",
    date: String(o.date ?? ""),
    description: String(o.description ?? ""),
    merchant: asString(o.merchant),
    venue: asString(o.venue),
    tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    funded_by: type === "expense" ? (fundedBy ?? "self") : fundedBy,
    is_recurring: Boolean(o.is_recurring),
    income_source: asString(o.income_source),
    to_account: asString(o.to_account),
    items: items.map((item) => ({ ...item, bucket: "wants" as Bucket })),
    confidence: typeof o.confidence === "number" ? o.confidence : 0,
  };
}

async function extractFromUserParts(args: {
  apiKey: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
  extractorStatic: string;
  userParts: GeminiUserPart[];
}): Promise<Extraction> {
  const extractor = await generateJson({
    apiKey: args.apiKey,
    schema: EXTRACTOR_SCHEMA,
    system: extractorSystem(args.today, args.taxonomy, args.extractorStatic),
    userParts: args.userParts,
  });

  const extraction = normalizeTaxonomyNames(
    asExtraction(extractor.data),
    args.taxonomy,
  );
  extraction.usage = { extractor: extractor.usage };
  extraction.meta = promptMeta(args.taxonomy, undefined, args.extractorStatic);

  if (extraction.type !== "expense" || extraction.items.length === 0) {
    return extraction;
  }

  const rules =
    args.bucketRules.trim() ||
    "No personal rules. Use subcategory default_bucket hints. If null or context is missing, assign wants.";

  const bucketRes = await generateJson({
    apiKey: args.apiKey,
    schema: BUCKET_SCHEMA,
    system: [BUCKET_STATIC_PROMPT, rules].join("\n\n"),
    userParts: [
      {
        text: JSON.stringify(
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
      },
    ],
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
  merged.meta = promptMeta(
    args.taxonomy,
    {
      prompt: BUCKET_STATIC_PROMPT,
      rules,
    },
    args.extractorStatic,
  );
  return merged;
}

export async function extractFromText(args: {
  apiKey: string;
  text: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
}): Promise<Extraction> {
  return extractFromUserParts({
    apiKey: args.apiKey,
    taxonomy: args.taxonomy,
    bucketRules: args.bucketRules,
    today: args.today,
    extractorStatic: EXTRACTOR_STATIC_PROMPT,
    userParts: [{ text: args.text }],
  });
}

export async function extractFromPhoto(args: {
  apiKey: string;
  image: Buffer;
  mimeType: string;
  caption: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
}): Promise<Extraction> {
  const caption = args.caption.trim();
  return extractFromUserParts({
    apiKey: args.apiKey,
    taxonomy: args.taxonomy,
    bucketRules: args.bucketRules,
    today: args.today,
    extractorStatic: PHOTO_EXTRACTOR_STATIC_PROMPT,
    userParts: [
      {
        inlineData: {
          mimeType: args.mimeType,
          data: args.image.toString("base64"),
        },
      },
      {
        text: caption || "Extract the transaction from this receipt.",
      },
    ],
  });
}

function extractionForPatch(current: Extraction): unknown {
  return {
    type: current.type,
    amount: current.amount,
    currency: current.currency,
    date: current.date,
    description: current.description,
    merchant: current.merchant,
    venue: current.venue,
    tags: current.tags,
    funded_by: current.funded_by,
    is_recurring: current.is_recurring,
    income_source: current.income_source,
    to_account: current.to_account,
    items: current.items.map((item) => ({
      description: item.description,
      amount: item.amount,
      category: item.category,
      subcategory: item.subcategory,
      item_type: item.item_type,
    })),
    confidence: current.confidence,
  };
}

export async function patchExtraction(args: {
  apiKey: string;
  current: Extraction;
  correction: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
}): Promise<Extraction> {
  const patched = await extractFromUserParts({
    apiKey: args.apiKey,
    taxonomy: args.taxonomy,
    bucketRules: args.bucketRules,
    today: args.today,
    extractorStatic: PATCH_EXTRACTOR_STATIC_PROMPT,
    userParts: [
      { text: JSON.stringify(extractionForPatch(args.current)) },
      { text: args.correction },
    ],
  });
  patched.date_source =
    patched.date === args.current.date
      ? args.current.date_source
      : "fix";
  return patched;
}

export async function extractFromVoice(args: {
  apiKey: string;
  audio: Buffer;
  mimeType: string;
  caption: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
}): Promise<Extraction> {
  const caption = args.caption.trim();
  return extractFromUserParts({
    apiKey: args.apiKey,
    taxonomy: args.taxonomy,
    bucketRules: args.bucketRules,
    today: args.today,
    extractorStatic: VOICE_EXTRACTOR_STATIC_PROMPT,
    userParts: [
      {
        inlineData: {
          mimeType: args.mimeType,
          data: args.audio.toString("base64"),
        },
      },
      {
        text: caption || "Extract the transaction from this voice note.",
      },
    ],
  });
}
