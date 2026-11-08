import { createHash } from "node:crypto";
import {
  normalizeTaxonomyNames,
  type Extraction,
  type ExtractionItem,
  type ExtractionMeta,
  type TaxonomySnapshot,
  type TokenUsage,
  type TxType,
} from "./extraction.js";
import { discountsOf, editedTotal, lineAmounts, withoutLeakedTotals, type PricedLine } from "./tax-tip.js";

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

/** The wait before each fallback attempt; tests replace `sleep` so a retry does not wait. */
export const retryWait = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const ENGLISH_DESCRIPTIONS =
  "Header and line descriptions are ordinary English. Translate French and other languages from the receipt or message. Keep brand names. Do not add commentary.";

const FUNDED_BY =
  "funded_by is who paid for an expense. Set it only when type is expense. For income and transfer return null.";

// Chequing is not in the Accounts list, so a null side means chequing.
const TRANSFER_ACCOUNTS =
  "A transfer moves money between chequing and the Accounts list: from_account is the account the money leaves and to_account the account it enters, each null when that side is chequing (\"took 200 out of <account>\" sets only from_account; \"moved 50 to <account>\" sets only to_account), and both are null for income and expenses.";

// The taxonomy says "Classify using ONLY these names" above the Merchants
// list. Without this line Flash-Lite often returned no merchant for a spoken
// name missing from that list (the voice-note golden's "Coffee Cart").
const MERCHANT =
  "merchant is the business the owner names or the receipt prints (\"a coffee at Maple Kiosk\" means Maple Kiosk), even when it is not in the Merchants list. When it matches a listed merchant, use the listed spelling. Return null only when no business is named.";

const NOTES =
  "notes is the owner's reason or circumstance for the transaction when they give one (why they bought it, what happened), translated to English and lightly copy-edited: fix spelling, typos, punctuation and grammar, and join broken fragments with connectors such as 'and'. Keep the owner's own wording and voice: do not rephrase, and never add facts, reasons or details they did not give. Example: 'raining realy hard didnt want walk' becomes 'it was raining really hard and I didn't want to walk'. Do not repeat the amount, merchant, items, date, or category. Take notes from the owner's message, caption, or voice, never from printed receipt text. Return null when they give no reason.";

// Line tags let one receipt line carry context the others do not (Phase 3.5).
// normalizeTaxonomyNames moves a tag every line repeats to the event.
const TAGS =
  "tags on the event are context for the whole transaction (a trip, an occasion). A line's tags are context the owner gives for that line only (\"the bananas were for <a name from the Tags list>\" tags the bananas line). Never repeat an event tag on a line. Use only names from the Tags list. Lines with no tag of their own return an empty list.";

const SPLIT_EVENTS =
  "Return events: one event per separate transaction, in the order the owner mentioned them. Split by place: one event per merchant or place. Amounts at the same place, or with no place given, are one expense with several items. Income and transfers are always their own event. A receipt photo is one event; the caption may add others. A date or funder stated once applies to every event unless an event states its own. notes and tags belong to the event they describe.";

const BUCKETS =
  "For each expense line set bucket_why (one short clause naming the rule applied), then bucket (needs or wants). Apply the owner's needs/wants rules at the end of this prompt. They override the (hint …) on subcategories. If no rule fits or context is missing, choose wants. Income and transfer events have no lines: return an empty items list.";

// The model reads prices, order discounts, taxes and the tip; tax-tip.ts
// shares them across the lines, because Flash-Lite split them unevenly
// (DECISIONS 2026-11-07, 2026-11-08). There is no tax, tip or discount line:
// the taxonomy has nowhere for one (#31).
// Shared by every prompt so an Edit keeps the same rule.
const LINE_AMOUNTS =
  "Amounts are strings with exactly two decimal places. For an expense, amount is the total paid, including tax and any tip (pourboire, gratuity) on the receipt or in the message, even when the tip is printed or written below the total. Each line's price is its pre-tax price as printed or said, after any discount on that line. discounts lists each discount on the whole order rather than on one line (a coupon, a member or loyalty discount, a percentage off the subtotal) as a positive amount, as printed or stated; an empty list when there is none. Never add tax or tip to a price, never take a whole-order discount off a price, and never add a tax, tip or discount line. taxes lists each tax amount exactly as printed or stated (GST/TPS and QST/TVQ are two entries; an empty list when none is given). tip is the tip as printed or stated, or null. taxable is true when the receipt's tax codes mark the line as taxed; when the codes mark the untaxed lines instead, the unmarked lines are the taxed ones; false when the receipt has no tax codes. The bot shares the discounts, taxes and tip across the lines, so the prices minus the discounts plus the taxes plus the tip MUST equal amount.";

// The venue list is short, so Gemini picked the nearest one for places that
// are none of them (a discount-store receipt became Dépanneur).
const VENUE =
  "venue is a name from the Venues list only when the place clearly is that kind of place (a pharmacy or drugstore is Pharmacy, a grocery store is Supermarket). A dollar or discount store, hardware store, department store, online shop, rideshare or warehouse store is none of them: return null. Never pick the nearest venue; when unsure, return null.";

// The lighter model gave a laundromat washer cycle Laundry Supply (#89).
// TAXONOMY.md classification rule 8.
const ITEM_TYPE_GOODS =
  "An item type that names goods (such as Laundry Supply or Cleaning Product) is for the goods themselves: a line paying for a machine cycle instead of goods keeps its subcategory and item_type is null. A laundromat washer or dryer cycle is Housing / Laundry with item_type null; detergent, softener or dryer sheets are Laundry Supply.";

// Receipts often print YY/MM/DD, which the lighter model read as DD/MM/YY,
// years in the past.
const DATE_READING =
  "Reading a printed date: when a receipt prints both a date with a 4-digit year (such as a footer 2031-03-14 18:02:11) and a 2-digit numeric date (such as 31/03/14), use the 4-digit one. When only an ambiguous NN/NN/NN date is printed, choose the reading that falls within the 12 months before today: read it as year/month/day (31/03/14 is year 31, month 03, day 14) when day/month/year would land years in the past or in the future. Never return a date more than a year from today unless the message says so.";

const EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a short text.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  LINE_AMOUNTS,
  "Item types must belong to the same category as the subcategory.",
  ITEM_TYPE_GOODS,
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  MERCHANT,
  VENUE,
  FUNDED_BY,
  TRANSFER_ACCOUNTS,
  NOTES,
  TAGS,
  SPLIT_EVENTS,
  BUCKETS,
  DATE_READING,
  "date is YYYY-MM-DD only when the user stated a calendar date (including today, yesterday, or a month and day). If they did not, return an empty string. Never guess today's date.",
].join("\n");

const PHOTO_EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a receipt photo.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  LINE_AMOUNTS,
  "Item types must belong to the same category as the subcategory.",
  ITEM_TYPE_GOODS,
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  MERCHANT,
  VENUE,
  FUNDED_BY,
  TRANSFER_ACCOUNTS,
  NOTES,
  TAGS,
  SPLIT_EVENTS,
  BUCKETS,
  DATE_READING,
  "date is YYYY-MM-DD only when printed on the receipt or stated in the caption (including today, yesterday, or a month and day). If neither, return an empty string. Never guess today's date or the photo send time.",
].join("\n");

const VOICE_EXTRACTOR_STATIC_PROMPT = [
  "You extract Canadian personal-finance transactions from a voice note.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  LINE_AMOUNTS,
  "Item types must belong to the same category as the subcategory.",
  ITEM_TYPE_GOODS,
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  MERCHANT,
  VENUE,
  FUNDED_BY,
  TRANSFER_ACCOUNTS,
  NOTES,
  TAGS,
  SPLIT_EVENTS,
  BUCKETS,
  DATE_READING,
  "date is YYYY-MM-DD only when the user stated a calendar date in the recording or caption (including today, yesterday, or a month and day). If they did not, return an empty string. Never guess today's date or the voice send time.",
].join("\n");

const PATCH_EXTRACTOR_STATIC_PROMPT = [
  "You apply a correction to an already extracted Canadian personal-finance transaction.",
  "Today is YYYY-MM-DD (America/Toronto). Currency is CAD.",
  "The user message is the current extraction as JSON, then the correction.",
  "Keep every field the correction does not change.",
  "Keep date unless the correction changes the calendar date. Never guess today's date.",
  DATE_READING,
  LINE_AMOUNTS,
  // Lite added a corrected tip on top of the old one (#60); the bot now
  // recomputes the total, so the model only replaces the field.
  "The current extraction lists each line's price, the discounts, the taxes and the tip. A correction to the tip, a tax or a discount replaces that value, it does not add to it, and a correction to a line's price replaces that price. Keep amount unchanged unless the correction states a new total paid: the bot recomputes the total from the prices, discounts, taxes and tip. When the correction states a new total, set amount to it and change the prices so the prices minus the discounts plus the taxes plus the tip equal it.",
  "Item types must belong to the same category as the subcategory.",
  ITEM_TYPE_GOODS,
  "category, subcategory, and item_type are separate fields. Never repeat the category inside subcategory or item_type. Example: category='Food and drink', subcategory='Takeout / Quick Service', item_type='Meals & Prepared Food'.",
  "Use Other … subcategories only when nothing more specific fits.",
  ENGLISH_DESCRIPTIONS,
  VENUE,
  FUNDED_BY,
  TRANSFER_ACCOUNTS,
  NOTES,
  TAGS,
  BUCKETS,
  "Keep each line's bucket and bucket_why unless the correction changes that line or states needs/wants; then reclassify that line with the rules.",
].join("\n");

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
  bucketRules: string,
): string {
  return [
    extractorStatic.replace("YYYY-MM-DD", today),
    taxonomyPrompt(taxonomy),
    `Needs/wants rules:\n${rulesText(bucketRules)}`,
  ].join("\n");
}

function promptMeta(
  model: string,
  taxonomy: TaxonomySnapshot,
  extractorStatic: string,
  bucketRules: string,
): ExtractionMeta {
  return {
    model,
    extractor_sha256: sha256Hex(extractorStatic),
    taxonomy_sha256: sha256Hex(taxonomyPrompt(taxonomy)),
    rules_sha256: sha256Hex(rulesText(bucketRules)),
  };
}

const ITEM_PROPERTIES = {
  description: { type: "STRING" },
  price: { type: "STRING" },
  taxable: { type: "BOOLEAN" },
  category: { type: "STRING" },
  subcategory: { type: "STRING" },
  item_type: { type: "STRING", nullable: true },
  // Before the bucket: who a line was for can bear on the needs/wants rules.
  tags: { type: "ARRAY", items: { type: "STRING" } },
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
    from_account: { type: "STRING", nullable: true },
    to_account: { type: "STRING", nullable: true },
    notes: { type: "STRING", nullable: true },
    taxes: { type: "ARRAY", items: { type: "STRING" } },
    discounts: { type: "ARRAY", items: { type: "STRING" } },
    tip: { type: "STRING", nullable: true },
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
    "from_account",
    "to_account",
    "taxes",
    "discounts",
    "tip",
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

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
};

type GeminiUserPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

export async function generateJson(args: {
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
    await retryWait.sleep(next.delayMs);
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

function asItem(raw: unknown): ExtractionItem & PricedLine {
  const o = raw as Record<string, unknown>;
  const why = asString(o.bucket_why);
  // A recording from before the price contract has each line's amount paid.
  const price = String(o.price ?? o.amount ?? "");
  return {
    description: String(o.description ?? ""),
    amount: price,
    price,
    taxable: o.taxable === true,
    category: String(o.category ?? ""),
    subcategory: String(o.subcategory ?? ""),
    item_type: asString(o.item_type),
    tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    bucket: o.bucket === "needs" ? "needs" : "wants",
    ...(why ? { bucket_why: why } : {}),
  };
}

function asExtraction(raw: unknown): Extraction {
  const o = raw as Record<string, unknown>;
  const priced = Array.isArray(o.items) ? o.items.map(asItem) : [];
  const taxes = Array.isArray(o.taxes) ? o.taxes.map(String) : [];
  const discounts = discountsOf(o.discounts);
  const tip = asString(o.tip);
  // Malformed parts keep the prices; validateExtraction names the bad amount.
  const amounts = lineAmounts(priced, taxes, tip, discounts);
  const items = amounts ? priced.map((item, i) => ({ ...item, amount: amounts[i] })) : priced;
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
    // Only a transfer leaves an account (a CHECK refuses it elsewhere).
    from_account: type === "transfer" ? asString(o.from_account) : null,
    to_account: asString(o.to_account),
    notes: asString(o.notes),
    taxes,
    discounts,
    tip,
    items,
    confidence: typeof o.confidence === "number" ? o.confidence : 0,
  };
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
  const meta = promptMeta(extractor.model, args.taxonomy, args.extractorStatic, args.bucketRules);
  return withoutLeakedTotals(raw.map((e) => normalizeTaxonomyNames(asExtraction(e), args.taxonomy))).map(
    (e, i) => ({ ...e, meta, usage: i === 0 ? { extractor: extractor.usage } : undefined }),
  );
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
    from_account: current.from_account ?? null,
    to_account: current.to_account,
    notes: current.notes ?? null,
    // A card from before 2026-11-07 has its tax and tip inside the amounts.
    taxes: current.taxes ?? [],
    discounts: current.discounts ?? [],
    tip: current.tip ?? null,
    // The parts, not the allocated amounts: the model edits what was read.
    items: current.items.map((item) => ({
      description: item.description,
      price: item.price ?? item.amount,
      taxable: item.taxable ?? false,
      category: item.category,
      subcategory: item.subcategory,
      item_type: item.item_type,
      tags: item.tags ?? [],
      bucket_why: item.bucket_why ?? null,
      bucket: item.bucket,
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
    system: extractorSystem(
      args.today,
      args.taxonomy,
      PATCH_EXTRACTOR_STATIC_PROMPT,
      args.bucketRules,
    ),
    userParts: [
      { text: JSON.stringify(extractionForPatch(args.current)) },
      { text: args.correction },
    ],
  });
  const patched = normalizeTaxonomyNames(asExtraction(extractor.data), args.taxonomy);
  const amount = patched.type === "expense" ? editedTotal(patched, args.current) : patched.amount;
  return {
    ...patched,
    amount,
    date_source: patched.date === args.current.date ? args.current.date_source : "fix",
    meta: promptMeta(extractor.model, args.taxonomy, PATCH_EXTRACTOR_STATIC_PROMPT, args.bucketRules),
    usage: { extractor: extractor.usage },
  };
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
