import { randomUUID } from "node:crypto";
import type { PendingIngestion } from "../../src/db.js";
import type { Extraction } from "../../src/extraction.js";

const base = {
  currency: "CAD",
  date: "2026-10-20",
  date_source: "stated",
  is_recurring: false,
  confidence: 0.9,
} as const;

export function expense(over: Partial<Extraction> = {}): Extraction {
  return {
    ...base,
    type: "expense",
    amount: "12.50",
    description: "groceries",
    merchant: "Acme Mart",
    venue: "Supermarket",
    tags: ["Social"],
    funded_by: "self",
    income_source: null,
    to_account: null,
    notes: "stocking up",
    items: [
      {
        description: "milk",
        amount: "4.50",
        category: "Food and drink",
        subcategory: "Groceries",
        item_type: "Ingredients & Staples",
        bucket: "needs",
      },
      {
        description: "cookies",
        amount: "8.00",
        category: "Food and drink",
        subcategory: "Groceries",
        item_type: "Snacks & Sweets",
        bucket: "wants",
      },
    ],
    ...over,
  };
}

export function income(over: Partial<Extraction> = {}): Extraction {
  return {
    ...base,
    type: "income",
    amount: "200.00",
    description: "paycheque",
    merchant: null,
    venue: null,
    tags: [],
    funded_by: null,
    income_source: "Salary",
    to_account: null,
    items: [],
    ...over,
  };
}

export function transfer(over: Partial<Extraction> = {}): Extraction {
  return {
    ...base,
    type: "transfer",
    amount: "50.00",
    description: "to savings",
    merchant: null,
    venue: null,
    tags: [],
    funded_by: null,
    income_source: null,
    to_account: "Emergency fund",
    items: [],
    ...over,
  };
}

export function pending(
  telegramUpdateId: number,
  extraction: Extraction,
  eventIndex = 0,
  mediaPath: string | null = null,
): PendingIngestion {
  return {
    id: randomUUID(),
    source: "text",
    mediaPath,
    telegramUpdateId,
    eventIndex,
    rawPayload: { update_id: telegramUpdateId },
    extraction,
  };
}
