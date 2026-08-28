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
  findAwaitingDateIngestion: vi.fn(),
  setIngestionAwaitingDate: vi.fn(),
  applyIngestionDate: vi.fn(),
}));
vi.mock("../src/gemini.js", () => ({
  extractFromText: vi.fn(),
  extractFromPhoto: vi.fn(),
}));
vi.mock("../src/telegram.js", () => ({
  answerCallbackQuery: vi.fn(),
  confirmDiscardKeyboard: vi.fn((id: string) => ({ confirm: id })),
  reviewKeyboard: vi.fn((id: string) => ({ confirm: id })),
  sendMessage: vi.fn(),
  downloadTelegramFile: vi.fn(),
  largestPhotoFileId: vi.fn(() => "file-big"),
}));
vi.mock("../src/s3.js", () => ({
  putReceipt: vi.fn(),
}));

import { getConfig } from "../src/config.js";
import {
  applyIngestionDate,
  findAwaitingDateIngestion,
  insertPendingIngestion,
  loadTaxonomy,
  setIngestionAwaitingDate,
} from "../src/db.js";
import { extractFromPhoto, extractFromText } from "../src/gemini.js";
import {
  downloadTelegramFile,
  reviewKeyboard,
  sendMessage,
} from "../src/telegram.js";
import { putReceipt } from "../src/s3.js";
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
    receiptsBucket: "finflow-receipts-test",
  });
  vi.mocked(loadTaxonomy).mockResolvedValue(taxonomy);
  vi.mocked(extractFromText).mockResolvedValue(extraction);
  vi.mocked(extractFromPhoto).mockResolvedValue(extraction);
  vi.mocked(insertPendingIngestion).mockResolvedValue({ id: "ing-1" });
  vi.mocked(findAwaitingDateIngestion).mockResolvedValue(null);
  vi.mocked(downloadTelegramFile).mockResolvedValue({
    bytes: Buffer.from([0xff, 0xd8, 0xff]),
    mimeType: "image/jpeg",
  });
  vi.mocked(putReceipt).mockResolvedValue(
    "11111111-1111-1111-1111-111111111111.jpg",
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
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
        extraction: expect.objectContaining({
          date: "2026-08-17",
          date_source: "stated",
        }),
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

  it("defaults a missing Gemini date to today and warns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T16:00:00Z"));
    vi.mocked(extractFromText).mockResolvedValue({ ...extraction, date: "" });

    await handler(
      event({
        update_id: 12,
        message: { chat: { id: 1 }, text: "12.50 lunch chipotle" },
      }),
    );

    expect(insertPendingIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        extraction: expect.objectContaining({
          date: "2026-08-18",
          date_source: "today_default",
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringMatching(/defaulted to today/i),
      { confirm: "ing-1" },
    );
  });

  it("asks for a date on Fix date and does not confirm", async () => {
    vi.mocked(setIngestionAwaitingDate).mockResolvedValue(true);

    await handler(
      event({
        update_id: 13,
        callback_query: {
          id: "cb1",
          data: "f:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          message: { chat: { id: 1 } },
        },
      }),
    );

    expect(setIngestionAwaitingDate).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringMatching(/send the date/i),
      { confirm: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    );
  });

  it("applies a date reply while awaiting and does not start a new extraction", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T16:00:00Z"));
    vi.mocked(findAwaitingDateIngestion).mockResolvedValue({
      id: "ing-1",
      extraction: {
        ...extraction,
        date: "2026-08-18",
        date_source: "today_default",
      },
    });
    vi.mocked(applyIngestionDate).mockResolvedValue(true);

    await handler(
      event({
        update_id: 14,
        message: { chat: { id: 1 }, text: "yesterday" },
      }),
    );

    expect(extractFromText).not.toHaveBeenCalled();
    expect(applyIngestionDate).toHaveBeenCalledWith(
      "ing-1",
      expect.objectContaining({ date: "2026-08-17", date_source: "fix" }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringContaining("2026-08-17"),
      { confirm: "ing-1" },
    );
  });

  it("does not treat a new expense as a date while awaiting_date", async () => {
    vi.mocked(findAwaitingDateIngestion).mockResolvedValue({
      id: "ing-1",
      extraction,
    });

    await handler(
      event({
        update_id: 15,
        message: { chat: { id: 1 }, text: "12.50 coffee" },
      }),
    );

    expect(extractFromText).not.toHaveBeenCalled();
    expect(applyIngestionDate).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringMatching(/waiting for a date/i),
    );
  });

  it("extracts a receipt photo, archives it, and offers Confirm", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-1111-1111-1111-111111111111",
    );

    await handler(
      event({
        update_id: 16,
        message: {
          chat: { id: 1 },
          photo: [{ file_id: "small" }, { file_id: "file-big" }],
          caption: "yesterday chipotle",
        },
      }),
    );

    expect(downloadTelegramFile).toHaveBeenCalledWith("t", "file-big");
    expect(extractFromPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "g",
        mimeType: "image/jpeg",
        caption: "yesterday chipotle",
      }),
    );
    expect(putReceipt).toHaveBeenCalledWith({
      bucket: "finflow-receipts-test",
      ingestionId: "11111111-1111-1111-1111-111111111111",
      body: Buffer.from([0xff, 0xd8, 0xff]),
      contentType: "image/jpeg",
    });
    expect(insertPendingIngestion).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-1111-1111-111111111111",
        source: "photo",
        mediaPath: "11111111-1111-1111-1111-111111111111.jpg",
        telegramUpdateId: 16,
        extraction: expect.objectContaining({
          date: "2026-08-17",
          date_source: "stated",
        }),
      }),
    );
    expect(reviewKeyboard).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { confirm: true },
    );
    expect(extractFromText).not.toHaveBeenCalled();
  });

  it("persists a dateless photo without Confirm", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-1111-1111-1111-111111111111",
    );
    vi.mocked(extractFromPhoto).mockResolvedValue({ ...extraction, date: "" });

    await handler(
      event({
        update_id: 17,
        message: {
          chat: { id: 1 },
          photo: [{ file_id: "file-big" }],
        },
      }),
    );

    expect(insertPendingIngestion).toHaveBeenCalled();
    expect(reviewKeyboard).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      { confirm: false },
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringMatching(/date missing/i),
      { confirm: "11111111-1111-1111-1111-111111111111" },
    );
  });

  it("does not start a new photo while awaiting a date", async () => {
    vi.mocked(findAwaitingDateIngestion).mockResolvedValue({
      id: "ing-1",
      extraction,
    });

    await handler(
      event({
        update_id: 18,
        message: {
          chat: { id: 1 },
          photo: [{ file_id: "file-big" }],
        },
      }),
    );

    expect(extractFromPhoto).not.toHaveBeenCalled();
    expect(putReceipt).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "t",
      1,
      expect.stringMatching(/waiting for a date/i),
    );
  });
});
