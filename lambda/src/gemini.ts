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
// Previous Flash: same family, less contended when the current one sheds load.
export const GEMINI_FALLBACK_MODEL = "gemini-3.5-flash";
// Last resort when both Flash models shed receipt-sized requests. Totals hold
// up; categories wobble, so the card flags extractions it produced.
export const GEMINI_LITE_MODEL = "gemini-3.5-flash-lite";

function endpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

// Overload (5xx) on one model tends to last longer than seconds, and free-tier
// quota (429) is per model, so each retry moves to the next model. Other 4xx
// mean the request itself is wrong and fail at once.
const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);
const ATTEMPTS = [
  { model: GEMINI_MODEL, delayMs: 0 },
  { model: GEMINI_FALLBACK_MODEL, delayMs: 2000 },
  { model: GEMINI_LITE_MODEL, delayMs: 2000 },
];

const ENGLISH_DESCRIPTIONS =
  "Header and line descriptions are ordinary English. Translate French and other languages from the receipt or message. Keep brand names. Do not add commentary.";

const FUNDED_BY =
  "funded_by is who paid for an expense. Set it only when type is expense. For income and transfer return null.";

const NOTES =
  "notes is the owner's reason or circumstance for the transaction when they give one (why they bought it, what happened), kept in their words and translated to English. Do not repeat the amount, merchant, items, date, or category. Take notes from the owner's message, caption, or voice, never from printed receipt text. Return null when they give no reason.";

const SPLIT_EVENTS =
  "Return events: one event per separate transaction, in the order the owner mentioned them. Split by place: one event per merchant or place. Amounts at the same place, or with no place given, are one expense with several items. Income and transfers are always their own event. A receipt photo is one event; the caption may add others. A date or funder stated once applies to every event unless an event states its own. notes and tags belong to the event they describe.";

const BUCKETS =
  "For each expense line set bucket_why (one short clause naming the rule applied), then bucket (needs or wants). Apply the owner's needs/wants rules at the end of this prompt. They override the (hint …) on subcategories. If no rule fits or context is missing, choose wants. On income and transfer lines return wants; it is ignored.";

const EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a short text.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
  "Item types must belong to the same category as the subcategory.",
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  FUNDED_BY,
  NOTES,
  SPLIT_EVENTS,
  BUCKETS,
  "date is YYYY-MM-DD only when the user stated a calendar date (including today, yesterday, or a month and day). If they did not, return an empty string. Never guess today's date.",
].join("\n");

const PHOTO_EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a receipt photo.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
  "Item types must belong to the same category as the subcategory.",
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  FUNDED_BY,
  NOTES,
  SPLIT_EVENTS,
  BUCKETS,
  "date is YYYY-MM-DD only when printed on the receipt or stated in the caption (including today, yesterday, or a month and day). If neither, return an empty string. Never guess today's date or the photo send time.",
].join("\n");

const VOICE_EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a voice note.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "Amounts are strings with exactly two decimal places. Line amounts include tax and MUST sum to the header amount.",
  "Item types must belong to the same category as the subcategory.",
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  FUNDED_BY,
  NOTES,
  SPLIT_EVENTS,
  BUCKETS,
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
  NOTES,
].join("\n");

const BUCKET_STATIC_PROMPT = [
  "You assign needs or wants to each expense line.",
  "Apply these rules. They override default_bucket hints.",
].join("\n\n");

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const NO_RULES =
  "No personal rules. Use each subcategory's default_bucket hint, shown as (hint …) in the taxonomy. If it has none or context is missing, choose wants.";

function rulesText(bucketRules: string): string {
  return bucketRules.trim() || NO_RULES;
}

/** Static text, taxonomy, then the owner's rules: the stable prefix comes first. */
function extractorSystem(
  today: string,
  taxonomy: TaxonomySnapshot,
  extractorStatic: string,
  bucketRules?: string,
): string {
  const parts = [
    extractorStatic.replace("YYYY-MM-DD", today),
    taxonomyPrompt(taxonomy),
  ];
  if (bucketRules !== undefined) {
    parts.push(`Needs/wants rules:\n${rulesText(bucketRules)}`);
  }
  return parts.join("\n");
}

function promptMeta(
  model: string,
  taxonomy: TaxonomySnapshot,
  extractorStatic: string,
  rules?: string,
): ExtractionMeta {
  const meta: ExtractionMeta = {
    model,
    extractor_sha256: sha256Hex(extractorStatic),
    taxonomy_sha256: sha256Hex(taxonomyPrompt(taxonomy)),
  };
  if (rules !== undefined) meta.rules_sha256 = sha256Hex(rules);
  return meta;
}

const ITEM_PROPERTIES = {
  description: { type: "STRING" },
  amount: { type: "STRING" },
  category: { type: "STRING" },
  subcategory: { type: "STRING" },
  item_type: { type: "STRING", nullable: true },
  bucket_why: { type: "STRING" },
  bucket: { type: "STRING", enum: ["needs", "wants"] },
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
    notes: { type: "STRING", nullable: true },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: ITEM_PROPERTIES,
        required: Object.keys(ITEM_PROPERTIES),
        // Without it Gemini may emit keys alphabetically, deciding bucket before category.
        propertyOrdering: Object.keys(ITEM_PROPERTIES),
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

const EVENTS_SCHEMA = {
  type: "OBJECT",
  properties: {
    events: { type: "ARRAY", items: EXTRACTOR_SCHEMA },
  },
  required: ["events"],
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
}): Promise<{ data: unknown; usage: TokenUsage; model: string }> {
  const request = {
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
  };
  let res: Response;
  let body: GeminiResponse;
  let model = ATTEMPTS[0].model;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(endpoint(model), request);
    // Overload responses are not always JSON.
    body = (await res.json().catch(() => ({}))) as GeminiResponse;
    const next = ATTEMPTS[attempt + 1];
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || !next) {
      break;
    }
    console.warn(
      `Gemini HTTP ${res.status} on ${model}; retry ${attempt + 1} on ${next.model}`,
    );
    await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    model = next.model;
  }
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
    model,
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

function asItem(raw: unknown): ExtractionItem {
  const o = raw as Record<string, unknown>;
  const why = asString(o.bucket_why);
  return {
    description: String(o.description ?? ""),
    amount: String(o.amount ?? ""),
    category: String(o.category ?? ""),
    subcategory: String(o.subcategory ?? ""),
    item_type: asString(o.item_type),
    bucket: o.bucket === "needs" ? "needs" : "wants",
    ...(why ? { bucket_why: why } : {}),
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
    notes: asString(o.notes),
    items,
    confidence: typeof o.confidence === "number" ? o.confidence : 0,
  };
}

/** One bucket call for every expense line of every event; split back by position. */
async function assignBuckets(args: {
  apiKey: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  events: Extraction[];
}): Promise<{ events: Extraction[]; usage: TokenUsage; model: string; rules: string } | null> {
  const lines = args.events.flatMap((event, eventIndex) =>
    event.type === "expense" ? event.items.map((item) => ({ event, eventIndex, item })) : [],
  );
  if (lines.length === 0) return null;

  const rules = rulesText(args.bucketRules);
  const res = await generateJson({
    apiKey: args.apiKey,
    schema: BUCKET_SCHEMA,
    system: [BUCKET_STATIC_PROMPT, rules].join("\n\n"),
    userParts: [
      {
        text: JSON.stringify(
          lines.map(({ event, eventIndex, item }, index) => ({
            index,
            event: eventIndex,
            description: item.description,
            amount: item.amount,
            category: item.category,
            subcategory: item.subcategory,
            item_type: item.item_type,
            default_bucket:
              args.taxonomy.subcategories.find(
                (s) => s.category === item.category && s.name === item.subcategory,
              )?.default_bucket ?? null,
            tags: event.tags,
            merchant: event.merchant,
            venue: event.venue,
          })),
        ),
      },
    ],
  });
  const buckets = (res.data as { buckets?: { bucket: Bucket; why?: string }[] }).buckets ?? [];
  if (buckets.length !== lines.length) {
    throw new Error(`bucket count ${buckets.length} != line count ${lines.length}`);
  }
  let next = 0;
  const events = args.events.map((event) => {
    if (event.type !== "expense" || event.items.length === 0) return event;
    const slice = buckets.slice(next, next + event.items.length);
    next += event.items.length;
    return mergeBuckets(event, slice);
  });
  return { events, usage: res.usage, model: res.model, rules };
}

/** Edit only: buckets from a second call, meta, and usage. */
async function finishEvents(args: {
  apiKey: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  extractorStatic: string;
  extractor: { usage: TokenUsage; model: string };
  events: Extraction[];
}): Promise<Extraction[]> {
  const bucketed = await assignBuckets(args);
  const meta = promptMeta(
    args.extractor.model,
    args.taxonomy,
    args.extractorStatic,
    bucketed?.rules,
  );
  if (bucketed) {
    meta.bucket_sha256 = sha256Hex(BUCKET_STATIC_PROMPT);
    meta.bucket_model = bucketed.model;
  }
  const usage = bucketed
    ? { extractor: args.extractor.usage, bucket: bucketed.usage }
    : { extractor: args.extractor.usage };
  return (bucketed?.events ?? args.events).map((event, i) => ({
    ...event,
    meta,
    usage: i === 0 ? usage : undefined,
  }));
}

async function extractEvents(args: {
  apiKey: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
  extractorStatic: string;
  userParts: GeminiUserPart[];
}): Promise<Extraction[]> {
  const extractor = await generateJson({
    apiKey: args.apiKey,
    schema: EVENTS_SCHEMA,
    system: extractorSystem(args.today, args.taxonomy, args.extractorStatic, args.bucketRules),
    userParts: args.userParts,
  });
  const raw = (extractor.data as { events?: unknown[] }).events ?? [];
  if (raw.length === 0) throw new Error("Gemini returned no events");
  // One call serves every event: meta on each, usage on event 0 only.
  const meta = promptMeta(
    extractor.model,
    args.taxonomy,
    args.extractorStatic,
    rulesText(args.bucketRules),
  );
  return raw.map((e, i) => ({
    ...normalizeTaxonomyNames(asExtraction(e), args.taxonomy),
    meta,
    usage: i === 0 ? { extractor: extractor.usage } : undefined,
  }));
}

export async function extractFromText(args: {
  apiKey: string;
  text: string;
  taxonomy: TaxonomySnapshot;
  bucketRules: string;
  today: string;
}): Promise<Extraction[]> {
  return extractEvents({
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
}): Promise<Extraction[]> {
  const caption = args.caption.trim();
  return extractEvents({
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
        text: caption || "Extract the transactions from this receipt.",
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
    notes: current.notes ?? null,
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
  const extractor = await generateJson({
    apiKey: args.apiKey,
    schema: EXTRACTOR_SCHEMA,
    system: extractorSystem(args.today, args.taxonomy, PATCH_EXTRACTOR_STATIC_PROMPT),
    userParts: [
      { text: JSON.stringify(extractionForPatch(args.current)) },
      { text: args.correction },
    ],
  });
  const [patched] = await finishEvents({
    apiKey: args.apiKey,
    taxonomy: args.taxonomy,
    bucketRules: args.bucketRules,
    extractorStatic: PATCH_EXTRACTOR_STATIC_PROMPT,
    extractor,
    events: [normalizeTaxonomyNames(asExtraction(extractor.data), args.taxonomy)],
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
}): Promise<Extraction[]> {
  const caption = args.caption.trim();
  return extractEvents({
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
        text: caption || "Extract the transactions from this voice note.",
      },
    ],
  });
}
