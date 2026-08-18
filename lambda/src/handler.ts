import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getConfig } from "./config.js";
import {
  confirmIngestion,
  discardIngestion,
  insertPendingIngestion,
  loadTaxonomy,
} from "./db.js";
import {
  formatPreview,
  normalizeTaxonomyNames,
  validateExtraction,
} from "./extraction.js";
import { extractFromText } from "./gemini.js";
import {
  answerCallbackQuery,
  confirmDiscardKeyboard,
  sendMessage,
} from "./telegram.js";

type TelegramChat = { id: number };
type TelegramMessage = {
  message_id?: number;
  chat: TelegramChat;
  text?: string;
  photo?: unknown[];
};
type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage;
};
type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

const CALLBACK_RE =
  /^([cd]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function ok(body: string): APIGatewayProxyResultV2 {
  return { statusCode: 200, body };
}

function unauthorized(): APIGatewayProxyResultV2 {
  return { statusCode: 401, body: "unauthorized" };
}

function parseUpdate(event: APIGatewayProxyEventV2): TelegramUpdate {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  return JSON.parse(raw) as TelegramUpdate;
}

function headerSecret(event: APIGatewayProxyEventV2): string | undefined {
  const headers = event.headers ?? {};
  return (
    headers["x-telegram-bot-api-secret-token"] ??
    headers["X-Telegram-Bot-Api-Secret-Token"]
  );
}

function todayToronto(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function handleMessage(
  update: TelegramUpdate,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<APIGatewayProxyResultV2> {
  const message = update.message!;
  if (!config.allowedChatIds.has(message.chat.id)) {
    return ok("ignored");
  }
  if (message.photo?.length) {
    await sendMessage(
      config.botToken,
      message.chat.id,
      "Photos come in the next slice. Send a text description for now.",
    );
    return ok("ok");
  }
  const text = message.text?.trim();
  if (!text) {
    return ok("ignored");
  }

  try {
    const taxonomy = await loadTaxonomy();
    const extraction = normalizeTaxonomyNames(
      await extractFromText({
        apiKey: config.geminiApiKey,
        text,
        taxonomy,
        bucketRules: config.bucketRules,
        today: todayToronto(),
      }),
      taxonomy,
    );
    const checks = validateExtraction(extraction, taxonomy);
    const preview = formatPreview(extraction, checks);
    if (!checks.ok) {
      await sendMessage(config.botToken, message.chat.id, preview);
      return ok("ok");
    }

    const inserted = await insertPendingIngestion({
      telegramUpdateId: update.update_id,
      rawPayload: update,
      extraction,
    });
    if (inserted === "duplicate") {
      return ok("duplicate");
    }

    await sendMessage(
      config.botToken,
      message.chat.id,
      preview,
      confirmDiscardKeyboard(inserted.id),
    );
    return ok("ok");
  } catch (err) {
    console.error("extract error", err);
    await sendMessage(
      config.botToken,
      message.chat.id,
      "Couldn't parse that. Try again in a sentence.",
    );
    return ok("ok");
  }
}

async function handleCallback(
  update: TelegramUpdate,
  botToken: string,
  allowedChatIds: Set<number>,
): Promise<APIGatewayProxyResultV2> {
  const cb = update.callback_query!;
  const chatId = cb.message?.chat.id;
  if (chatId === undefined || !allowedChatIds.has(chatId)) {
    return ok("ignored");
  }

  const match = cb.data?.match(CALLBACK_RE);
  if (!match) {
    await answerCallbackQuery(botToken, cb.id, "Unknown action.");
    return ok("ok");
  }

  const action = match[1];
  const ingestionId = match[2];

  let ack: string;
  if (action === "c") {
    const result = await confirmIngestion(ingestionId);
    ack = result === "confirmed" ? "Saved." : "Already handled.";
  } else {
    const result = await discardIngestion(ingestionId);
    ack = result === "discarded" ? "Discarded." : "Already handled.";
  }

  await answerCallbackQuery(botToken, cb.id, ack);
  await sendMessage(botToken, chatId, ack);
  return ok("ok");
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  try {
    const config = await getConfig();
    const secret = headerSecret(event);
    if (secret !== config.webhookSecret) {
      return unauthorized();
    }

    const update = parseUpdate(event);

    if (update.message) {
      return await handleMessage(update, config);
    }

    if (update.callback_query) {
      return await handleCallback(
        update,
        config.botToken,
        config.allowedChatIds,
      );
    }

    return ok("ignored");
  } catch (err) {
    console.error("handler error", err);
    return { statusCode: 500, body: "error" };
  }
}
