export type Money = string;
export type Bucket = "needs" | "wants";
export type TxType = "income" | "expense" | "transfer";

export type ExtractionItem = {
  description: string;
  amount: Money;
  category: string;
  subcategory: string;
  item_type: string | null;
  bucket: Bucket;
  bucket_why?: string;
};

export type TokenUsage = { input: number; output: number };

export type ExtractionMeta = {
  model: string;
  extractor_sha256: string;
  taxonomy_sha256: string;
  bucket_sha256?: string;
  rules_sha256?: string;
};

export type Extraction = {
  type: TxType;
  amount: Money;
  currency: "CAD";
  date: string;
  description: string;
  merchant: string | null;
  venue: string | null;
  tags: string[];
  funded_by: string;
  is_recurring: boolean;
  income_source: string | null;
  to_account: string | null;
  items: ExtractionItem[];
  confidence: number;
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

const CENTS = /^(\d+)\.(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/** Gemini often repeats "Category / " inside subcategory and item_type. */
export function normalizeTaxonomyNames(
  extraction: Extraction,
  taxonomy: TaxonomySnapshot,
): Extraction {
  return {
    ...extraction,
    items: extraction.items.map((item) => {
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
  if (!DATE.test(extraction.date)) {
    errors.push(`date must be YYYY-MM-DD, got ${extraction.date}`);
  }

  const headerCents = parseCents(extraction.amount);
  if (headerCents === null) {
    errors.push(`amount must be two-decimal, got ${extraction.amount}`);
  }

  if (!hasName(taxonomy.fundingSources, extraction.funded_by)) {
    errors.push(`unknown funding source: ${extraction.funded_by}`);
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
    !hasName(taxonomy.merchants, extraction.merchant)
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
  if (extraction.type === "transfer" && !extraction.to_account) {
    errors.push("transfer requires to_account");
  }
  if (
    extraction.type === "transfer" &&
    extraction.to_account &&
    !hasName(taxonomy.accounts, extraction.to_account)
  ) {
    errors.push(`unknown account: ${extraction.to_account}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function mergeBuckets(
  extraction: Extraction,
  buckets: { bucket: Bucket; why?: string }[],
): Extraction {
  if (buckets.length !== extraction.items.length) {
    throw new Error(
      `bucket count ${buckets.length} != item count ${extraction.items.length}`,
    );
  }
  return {
    ...extraction,
    items: extraction.items.map((item, i) => ({
      ...item,
      bucket: buckets[i].bucket,
      bucket_why: buckets[i].why,
    })),
  };
}

export function formatPreview(
  extraction: Extraction,
  checks: CheckResult,
): string {
  const lines: string[] = [];
  const title =
    extraction.type.charAt(0).toUpperCase() + extraction.type.slice(1);
  lines.push(
    `${title} · ${extraction.date} · ${extraction.currency} ${extraction.amount}`,
  );
  lines.push(extraction.description);
  if (extraction.merchant) lines.push(`Merchant: ${extraction.merchant}`);
  if (extraction.venue) lines.push(`Venue: ${extraction.venue}`);
  if (extraction.tags.length) lines.push(`Tags: ${extraction.tags.join(", ")}`);
  lines.push(
    `Funded by: ${extraction.funded_by} · Recurring: ${extraction.is_recurring ? "yes" : "no"}`,
  );
  if (extraction.income_source) {
    lines.push(`Income source: ${extraction.income_source}`);
  }
  if (extraction.to_account) {
    lines.push(`To account: ${extraction.to_account}`);
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
