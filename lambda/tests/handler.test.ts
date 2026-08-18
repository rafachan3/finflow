import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

vi.mock("../src/config.js", () => ({
  getConfig: vi.fn(),
}));
vi.mock("../src/db.js", () => ({
  confirmIngestion: vi.fn(),
  discardIngestion: vi.fn(),
  insertPendingIngestion: vi.fn(),
  loadTaxonomy: vi.fn(),
}));
vi.mock("../src/gemini.js", () => ({
  extractFromText: vi.fn(),
}));
vi.mock("../src/telegram.js", () => ({
  answerCallbackQuery: vi.fn(),
  confirmDiscardKeyboard: vi.fn((id: string) => ({ confirm: id })),
  sendMessage: vi.fn(),
}));

import { getConfig } from "../src/config.js";
import {
  insertPendingIngestion,
  loadTaxonomy,
} from "../src/db.js";
import { extractFromText } from "../src/gemini.js";
import { sendMessage } from "../src/telegram.js";
import { handler } from "../src/handler.js";
import type { Extraction, TaxonomySnapshot } from "../src/extraction.js";

const taxonomy: TaxonomySnapshot = {
  subcategories: [
    {
      category: "Food and drink",
      name: "Takeout / Quick Service",
      default_bucket: "wants",
    },
  ],
  itemTypes: [{ category: "Food and drink", name: "Meals & Prepared Food" }],
  venues: ["Fast Food"],
  tags: ["Social"],
  fundingSources: ["self"],
  merchants: ["Chipotle"],
  incomeSources: [],
  accounts: [],
};

const extraction: Extraction = {
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
      bucket: "wants",
      bucket_why: "takeout",
    },
  ],
  confidence: 0.9,
};

function event(body: unknown, secret = "s"): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: { "x-telegram-bot-api-secret-token": secret },
    requestContext: {} as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.mocked(getConfig).mockResolvedValue({
    botToken: "t",
    webhookSecret: "s",
    allowedChatIds: new Set([1]),
    databaseUrl: "postgres://x",
    geminiApiKey: "g",
    bucketRules: "Takeout is wants.",
  });
  vi.mocked(loadTaxonomy).mockResolvedValue(taxonomy);
  vi.mocked(extractFromText).mockResolvedValue(extraction);
  vi.mocked(insertPendingIngestion).mockResolvedValue({ id: "ing-1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function bodyOf(
  result: APIGatewayProxyResultV2,
): Promise<{ statusCode: number; body?: string }> {
  if (typeof result === "string") return { statusCode: 200, body: result };
  return { statusCode: result.statusCode ?? 200, body: result.body };
}

describe("handler", () => {
  it("rejects a bad webhook secret", async () => {
    const res = await bodyOf(
      await handler(event({ update_id: 1, message: { chat: { id: 1 }, text: "hi" } }, "nope")),
    );
    expect(res.statusCode).toBe(401);
  });

  it("previews a valid extraction with Confirm buttons and persists pending", async () => {
    await handler(
      event({
        update_id: 9,
        message: { chat: { id: 1 }, text: "12.50 lunch chipotle" },
      }),
    );

    expect(extractFromText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "12.50 lunch chipotle",
        apiKey: "g",
        bucketRules: "Takeout is wants.",
      }),
    );
    expect(insertPendingIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramUpdateId: 9,
        extraction,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringContaining("Confirm to save"),
      { confirm: "ing-1" },
    );
  });

  it("does not persist or offer Confirm when checks fail", async () => {
    vi.mocked(extractFromText).mockResolvedValue({
      ...extraction,
      amount: "99.00",
    });

    await handler(
      event({
        update_id: 10,
        message: { chat: { id: 1 }, text: "99 lunch" },
      }),
    );

    expect(insertPendingIngestion).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringContaining("✗"),
    );
    const args = vi.mocked(sendMessage).mock.calls[0];
    expect(args.length).toBe(3);
  });

  it("tells the user photos are not in this slice", async () => {
    await handler(
      event({
        update_id: 11,
        message: {
          chat: { id: 1 },
          photo: [{ file_id: "x" }],
        },
      }),
    );
    expect(extractFromText).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringMatching(/photo/i),
    );
  });
});
