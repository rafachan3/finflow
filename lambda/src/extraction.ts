import { cleanMerchantName, merchantKey } from "./commands.js";

export type Money = string;
export type Bucket = "needs" | "wants";
export type TxType = "income" | "expense" | "transfer";

export type ExtractionItem = {
  description: string;
  amount: Money;
  category: string;
  subcategory: string;
  item_type: string | null;
  /** Context for this line only; absent on rows extracted before line tags. */
  tags?: string[];
  /** Line tags the model gave that are not in the Tags list; the card warns. */
  dropped_tags?: string[];
  bucket: Bucket;
  bucket_why?: string;
};

export type TokenUsage = { input: number; output: number };

export type ExtractionMeta = {
  model: string;
  extractor_sha256: string;
  taxonomy_sha256: string;
  /** Only on rows from before 2026-10-28, when buckets took a second call. */
  bucket_sha256?: string;
  bucket_model?: string;
  rules_sha256?: string;
};

export type DateSource = "stated" | "today_default" | "missing" | "fix";

export type Extraction = {
  type: TxType;
  amount: Money;
  currency: "CAD";
  date: string;
  date_source?: DateSource;
  description: string;
  merchant: string | null;
  venue: string | null;
  tags: string[];
  funded_by: string | null;
  is_recurring: boolean;
  income_source: string | null;
  /** Account a transfer leaves; null = chequing. Absent on rows extracted before withdrawals. */
  from_account?: string | null;
  /** Account a transfer enters; null = chequing. */
  to_account: string | null;
  /** Owner's stated why/circumstance; absent on rows extracted before notes. */
  notes?: string | null;
  items: ExtractionItem[];
  confidence: number;
  /** `bucket` only on rows from before 2026-10-28. */
  usage?: { extractor?: TokenUsage; bucket?: TokenUsage };
  meta?: ExtractionMeta;
};

export type TaxonomySnapshot = {
  subcategories: {
    category: string;
    name: string;
    default_bucket: Bucket | null;
  }[];
  itemTypes: { category: string; name: string }[];
  venues: string[];
  tags: string[];
  fundingSources: string[];
  merchants: string[];
  incomeSources: string[];
  accounts: string[];
};

export type CheckResult =
  | { ok: true; errors: string[]; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** A likely earlier copy of a saved card: the same photo, or the same money event. */
export type DuplicateMatch = {
  rule: "photo" | "amount";
  /** saved = a confirmed transaction; pending = a card still open. */
  status: "saved" | "pending";
  /** The match's date; for a photo match, the day its card was sent. */
  date: string;
  amount: Money;
  description: string;
};

const CENTS = /^(\d+)\.(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MISSING_DATE =
  "date missing: send YYYY-MM-DD, Aug 10, or yesterday";
const DEFAULTED_TODAY = "date defaulted to today";

export { MISSING_DATE };

export function isValidIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isoFromUtc(dt: Date): string {
  const year = dt.getUTCFullYear();
  const month = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftIso(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return isoFromUtc(new Date(Date.UTC(year, month - 1, day + days)));
}

function monthDayIso(
  month: number,
  day: number,
  today: string,
  year?: number,
): string | null {
  if (year !== undefined) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return isValidIsoDate(iso) ? iso : null;
  }
  const [ty] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const thisYear = `${ty}-${pad(month)}-${pad(day)}`;
  if (!isValidIsoDate(thisYear)) return null;
  if (thisYear <= today) return thisYear;
  const lastYear = `${ty - 1}-${pad(month)}-${pad(day)}`;
  return isValidIsoDate(lastYear) ? lastYear : null;
}

/** Parse a Fix-date reply. Whole message must be a date, not an expense. */
export function parseDateReply(text: string, today: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "today") return today;
  if (lower === "yesterday") return shiftIso(today, -1);
  if (isValidIsoDate(raw)) return raw;

  const named =
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:[,\s]+(\d{4}))?$/i.exec(
      raw,
    );
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : undefined;
    return monthDayIso(month, day, today, year);
  }

  const dayFirst =
    /^(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:[,\s]+(\d{4}))?$/i.exec(
      raw,
    );
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const year = dayFirst[3] ? Number(dayFirst[3]) : undefined;
    return monthDayIso(month, day, today, year);
  }

  return null;
}

export type DatePolicy = {
  date: string;
  date_source: DateSource;
  warnings: string[];
  errors: string[];
};

export function applyDatePolicy(args: {
  channel: "text" | "photo" | "voice";
  extractedDate: string | null | undefined;
  today: string;
}): DatePolicy {
  const raw = (args.extractedDate ?? "").trim();
  if (isValidIsoDate(raw)) {
    return { date: raw, date_source: "stated", warnings: [], errors: [] };
  }
  if (args.channel === "photo") {
    return {
      date: "",
      date_source: "missing",
      warnings: [],
      errors: [MISSING_DATE],
    };
  }
  return {
    date: args.today,
    date_source: "today_default",
    warnings: [DEFAULTED_TODAY],
    errors: [],
  };
}

export function parseCents(amount: string): number | null {
  const m = amount.match(CENTS);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]);
}

function hasName(list: string[], name: string | null): boolean {
  return name !== null && list.includes(name);
}

function stripCategoryPrefix(category: string, raw: string): string {
  const prefix = `${category} / `;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

/**
 * Each tag in one place: a tag every line carries is context for the whole
 * transaction and moves to the header, and a line keeps only the tags the
 * header lacks, once each.
 */
export function canonicalTags(
  header: string[],
  lines: string[][],
): { tags: string[]; lineTags: string[][] } {
  const everyLine = (lines[0] ?? []).filter((t) => lines.every((l) => l.includes(t)));
  const tags = [...new Set([...header, ...everyLine])];
  return { tags, lineTags: lines.map((l) => [...new Set(l)].filter((t) => !tags.includes(t))) };
}

/**
 * Gemini often repeats "Category / " inside subcategory and item_type; tags go
 * canonical. A line tag missing from the Tags list is dropped before that, so
 * one copied onto every line never becomes a header tag that blocks the card.
 */
export function normalizeTaxonomyNames(
  extraction: Extraction,
  taxonomy: TaxonomySnapshot,
): Extraction {
  const unknown = extraction.items.map((item) =>
    (item.tags ?? []).filter((t) => !hasName(taxonomy.tags, t)),
  );
  const { tags, lineTags } = canonicalTags(
    extraction.tags,
    extraction.items.map((item) => (item.tags ?? []).filter((t) => hasName(taxonomy.tags, t))),
  );
  return {
    ...extraction,
    tags,
    items: extraction.items.map((item, i) => {
      const subcategory = stripCategoryPrefix(item.category, item.subcategory);
      const itemTypeRaw = item.item_type
        ? stripCategoryPrefix(item.category, item.item_type)
        : null;
      const sub = taxonomy.subcategories.find(
        (s) => s.category === item.category && s.name === subcategory,
      );
      const it = itemTypeRaw
        ? taxonomy.itemTypes.find(
            (t) => t.category === item.category && t.name === itemTypeRaw,
          )
        : undefined;
      return {
        ...item,
        subcategory: sub?.name ?? subcategory,
        item_type: itemTypeRaw === null ? null : (it?.name ?? itemTypeRaw),
        tags: lineTags[i],
        ...(unknown[i].length
          ? { dropped_tags: [...new Set([...(item.dropped_tags ?? []), ...unknown[i]])] }
          : {}),
      };
    }),
  };
}

export function validateExtraction(
  extraction: Extraction,
  taxonomy: TaxonomySnapshot,
): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (extraction.currency !== "CAD") {
    errors.push(`currency must be CAD, got ${extraction.currency}`);
  }
  if (extraction.date_source === "missing" || extraction.date === "") {
    errors.push(MISSING_DATE);
  } else if (!isValidIsoDate(extraction.date)) {
    errors.push(`date must be YYYY-MM-DD, got ${extraction.date}`);
  }
  if (extraction.date_source === "today_default") {
    warnings.push(DEFAULTED_TODAY);
  }

  const headerCents = parseCents(extraction.amount);
  if (headerCents === null) {
    errors.push(`amount must be two-decimal, got ${extraction.amount}`);
  }

  if (extraction.type === "expense") {
    if (!hasName(taxonomy.fundingSources, extraction.funded_by)) {
      errors.push(`unknown funding source: ${extraction.funded_by}`);
    }
  }

  if (extraction.venue !== null && !hasName(taxonomy.venues, extraction.venue)) {
    errors.push(`unknown venue: ${extraction.venue}`);
  }

  for (const tag of extraction.tags) {
    if (!hasName(taxonomy.tags, tag)) {
      errors.push(`unknown tag: ${tag}`);
    }
  }

  if (
    extraction.merchant !== null &&
    !taxonomy.merchants.some((m) => merchantKey(m) === merchantKey(extraction.merchant!))
  ) {
    warnings.push(
      `merchant "${extraction.merchant}" is not in lookup; will save without merchant`,
    );
  }

  if (extraction.type === "expense") {
    if (extraction.items.length < 1) {
      errors.push("expense needs at least one line");
    }
    let lineSum = 0;
    let linesOk = headerCents !== null;
    for (const item of extraction.items) {
      const cents = parseCents(item.amount);
      if (cents === null) {
        errors.push(`line amount must be two-decimal: ${item.amount}`);
        linesOk = false;
      } else {
        lineSum += cents;
      }
      const sub = taxonomy.subcategories.find(
        (s) => s.name === item.subcategory && s.category === item.category,
      );
      if (!sub) {
        errors.push(
          `unknown ${item.category} / ${item.subcategory} for "${item.description}"`,
        );
      }
      if (item.item_type) {
        const it = taxonomy.itemTypes.find(
          (t) => t.name === item.item_type && t.category === item.category,
        );
        if (!it) {
          errors.push(
            `item type "${item.item_type}" is not valid for ${item.category}`,
          );
        }
      }
      for (const tag of item.dropped_tags ?? []) {
        warnings.push(`tag "${tag}" is not in lookup; "${item.description}" will save without it`);
      }
      if (item.bucket !== "needs" && item.bucket !== "wants") {
        errors.push(`bucket must be needs or wants on "${item.description}"`);
      }
    }
    if (linesOk && headerCents !== null && lineSum !== headerCents) {
      errors.push(
        `lines sum ${(lineSum / 100).toFixed(2)} != header ${extraction.amount}`,
      );
    }
  } else if (extraction.items.length > 0) {
    errors.push(`${extraction.type} must have no line items`);
  }

  if (extraction.type === "income" && !extraction.income_source) {
    errors.push("income requires income_source");
  }
  if (
    extraction.type === "income" &&
    extraction.income_source &&
    !hasName(taxonomy.incomeSources, extraction.income_source)
  ) {
    errors.push(`unknown income source: ${extraction.income_source}`);
  }
  if (extraction.type === "transfer") {
    // A null side is chequing: from only is a withdrawal, to only a deposit.
    const from = extraction.from_account ?? null;
    const to = extraction.to_account;
    if (!from && !to) {
      errors.push("transfer requires from_account or to_account");
    }
    for (const account of [from, to]) {
      if (account && !hasName(taxonomy.accounts, account)) {
        errors.push(`unknown account: ${account}`);
      }
    }
    if (from && from === to) {
      errors.push(`transfer from and to the same account: ${from}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Confirm writes this name (or null) to transactions.funding_source_id. */
export function fundingSourceToPersist(
  type: TxType,
  fundedBy: string | null,
): string | null {
  return type === "expense" ? fundedBy : null;
}

/** The " (k of n)" a card header shows; empty unless the message made 2+ cards. */
function positionLabel(position?: { index: number; count: number }): string {
  return position && position.count > 1
    ? ` (${position.index + 1} of ${position.count})`
    : "";
}

const HEADER_POSITION = /( \(\d+ of \d+\))$/;

/** An ack with the position its card's header shows; unchanged for an unlabelled card. */
export function withPosition(ack: string, cardText?: string): string {
  const label = cardText?.split("\n")[0].match(HEADER_POSITION)?.[1] ?? "";
  return ack + label;
}

/** At most one card warning for findDuplicates' ordered matches: a photo match wins. */
export function duplicateWarnings(matches: DuplicateMatch[]): string[] {
  const [first] = matches;
  if (!first) return [];
  const status = first.status === "saved" ? "saved" : "still pending";
  if (first.rule === "photo") {
    return [`Same photo as a card from ${first.date} (${status})`];
  }
  // Photo matches sort first, so every match here is an amount match.
  const more = matches.length > 1 ? ` (+${matches.length - 1} more)` : "";
  return [
    `Possible duplicate: CAD ${first.amount} on ${first.date}, "${first.description}" (${status})${more}`,
  ];
}

/** Saved purchases naming an unlisted merchant before a card suggests adding it. */
export const FREQUENT_MERCHANT_MIN = 3;

/** The card's hint to /addmerchant a merchant bought from often, unless the command would refuse the name. */
export function merchantHint(frequent: { name: string; count: number } | null): string | undefined {
  if (!frequent || "error" in cleanMerchantName(frequent.name)) return undefined;
  const { name, count } = frequent;
  return `You've bought from ${name} ${count} times. Send /addmerchant ${name} to track it.`;
}

export function formatPreview(
  extraction: Extraction,
  checks: CheckResult,
  position?: { index: number; count: number },
  hint?: string,
): string {
  const lines: string[] = [];
  const title =
    extraction.type.charAt(0).toUpperCase() + extraction.type.slice(1);
  const label = positionLabel(position);
  lines.push(
    `${title} · ${extraction.date} · ${extraction.currency} ${extraction.amount}${label}`,
  );
  lines.push(extraction.description);
  if (extraction.notes) lines.push(`Note: ${extraction.notes}`);
  if (extraction.merchant) lines.push(`Merchant: ${extraction.merchant}`);
  if (extraction.venue) lines.push(`Venue: ${extraction.venue}`);
  if (extraction.tags.length) lines.push(`Tags: ${extraction.tags.join(", ")}`);
  const recurring = `Recurring: ${extraction.is_recurring ? "yes" : "no"}`;
  if (extraction.type === "expense") {
    lines.push(`Funded by: ${extraction.funded_by} · ${recurring}`);
  } else {
    lines.push(recurring);
  }
  if (extraction.income_source) {
    lines.push(`Income source: ${extraction.income_source}`);
  }
  if (extraction.from_account) {
    lines.push(`From account: ${extraction.from_account}`);
  }
  if (extraction.to_account || extraction.from_account) {
    lines.push(`To account: ${extraction.to_account ?? "chequing"}`);
  }

  if (extraction.items.length) {
    lines.push("");
    lines.push("Lines");
    for (const item of extraction.items) {
      const type = item.item_type ? ` / ${item.item_type}` : "";
      lines.push(`• ${item.description} — ${item.amount}`);
      lines.push(
        `  ${item.category} / ${item.subcategory}${type} / ${item.bucket}`,
      );
      if (item.bucket_why) lines.push(`  ${item.bucket_why}`);
      if (item.tags?.length) lines.push(`  Tags: ${item.tags.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Checks");
  if (checks.ok) {
    const parts = extraction.items.map((i) => i.amount);
    const sum =
      parts.length > 0 ? `${parts.join(" + ")} = ${extraction.amount}` : "n/a";
    lines.push(`✓ lines ${sum}`);
    lines.push("✓ taxonomy matches");
    lines.push("✓ buckets assigned");
  }
  for (const w of checks.warnings) {
    lines.push(`! ${w}`);
  }
  if (hint) lines.push(`💡 ${hint}`);
  // Lite is the overload fallback: totals hold, classification wobbles.
  const models = [extraction.meta?.model, extraction.meta?.bucket_model];
  if (models.some((m) => m?.includes("-lite"))) {
    lines.push(
      "! read by a lighter model while Gemini was busy — check categories and buckets",
    );
  }
  for (const e of checks.errors) {
    lines.push(`✗ ${e}`);
  }

  if (checks.ok) {
    lines.push("");
    lines.push("Confirm to save · Discard to drop");
  }

  const text = lines.join("\n");
  if (text.length <= 4000) return text;
  return `${text.slice(0, 3900)}\n…truncated`;
}
