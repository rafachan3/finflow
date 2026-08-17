import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getConfig } from "./config.js";
import {
  confirmIngestion,
  discardIngestion,
  insertPendingIngestion,
} from "./db.js";
import { parseQuickLog } from "./parse.js";
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

const USAGE = "Send: 12.50 lunch chipotle";
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

async function handleMessage(
  update: TelegramUpdate,
  botToken: string,
  allowedChatIds: Set<number>,
): Promise<APIGatewayProxyResultV2> {
  const message = update.message!;
  if (!allowedChatIds.has(message.chat.id)) {
    return ok("ignored");
  }
  if (!message.text) {
    return ok("ignored");
  }

  const parsed = parseQuickLog(message.text);
  if (!parsed) {
    await sendMessage(botToken, message.chat.id, USAGE);
    return ok("ok");
  }

  const inserted = await insertPendingIngestion({
    telegramUpdateId: update.update_id,
    rawPayload: update,
    extraction: parsed,
  });
  if (inserted === "duplicate") {
    return ok("duplicate");
  }

  await sendMessage(
    botToken,
    message.chat.id,
    `CAD ${parsed.amount} — ${parsed.description}`,
    confirmDiscardKeyboard(inserted.id),
  );
  return ok("ok");
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
      return await handleMessage(
        update,
        config.botToken,
        config.allowedChatIds,
      );
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
