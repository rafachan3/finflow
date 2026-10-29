import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getConfig } from "./config.js";
import {
  applyIngestionDate,
  applyIngestionEdit,
  confirmIngestion,
  discardIngestion,
  findAwaitingIngestion,
  findDuplicates,
  insertPendingIngestions,
  listPendingIngestions,
  loadTaxonomy,
  type PendingIngestion,
  setIngestionAwaitingDate,
  setIngestionAwaitingEdit,
} from "./db.js";
import {
  applyDatePolicy,
  duplicateWarnings,
  formatPreview,
  MISSING_DATE,
  normalizeTaxonomyNames,
  parseDateReply,
  validateExtraction,
  withPosition,
  type CheckResult,
  type Extraction,
  type TaxonomySnapshot,
} from "./extraction.js";
import { extractFromPhoto, extractFromText, extractFromVoice, patchExtraction } from "./gemini.js";
import { putReceipt } from "./s3.js";
import {
  answerCallbackQuery,
  discardKeyboard,
  downloadTelegramFile,
  largestPhotoFileId,
  reviewKeyboard,
  sendMessage,
  voiceFileId,
} from "./telegram.js";

type TelegramChat = { id: number };
type TelegramMessage = {
  message_id?: number;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: unknown[];
  voice?: unknown;
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
  /^([cdfe]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const ASK_DATE =
  "Send the date as YYYY-MM-DD, Aug 10, or yesterday.";
const WAITING_DATE =
  "Still waiting for a date for the previous item. Send YYYY-MM-DD, Aug 10, or yesterday — or tap Discard.";
const ASK_EDIT =
  "Send the correction — amount, category, a line, whatever is wrong.";
const WAITING_EDIT =
  "Still waiting for a correction for the previous item. Send the change — or tap Discard.";

const BUSY_WAITING =
  "Another card is waiting for a date or correction. Send it, or tap Discard on that card, then try again.";

/** Telegram appends @botname to a command in a group or when picked from the menu. */
const PENDING_COMMAND = /^\/pending(@\w+)?$/i;
const NOTHING_PENDING = "No pending cards.";

const GEMINI_OVERLOADED =
  "Gemini is overloaded right now. Send it again in a minute.";

/** Server overload that survived generateJson's retries is not the owner's input. */
function failureReply(err: unknown, fallback: string): string {
  return err instanceof Error && /^Gemini HTTP 50[034]\b/.test(err.message)
    ? GEMINI_OVERLOADED
    : fallback;
}

function ok(body: string): APIGatewayProxyResultV2 {
  return { statusCode: 200, body };
}

async function busyWaiting(
  botToken: string,
  callbackId: string,
  chatId: number,
): Promise<APIGatewayProxyResultV2> {
  await answerCallbackQuery(botToken, callbackId, "Finish the waiting card first.");
  await sendMessage(botToken, chatId, BUSY_WAITING);
  return ok("ok");
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

export function todayToronto(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function withDatePolicy(
  extraction: Extraction,
  today: string,
  channel: "text" | "photo" | "voice" = "text",
): Extraction {
  const policy = applyDatePolicy({
    channel,
    extractedDate: extraction.date,
    today,
  });
  return {
    ...extraction,
    date: policy.date,
    date_source: policy.date_source,
  };
}

function previewOffer(extraction: Extraction, checks: { ok: boolean; errors: string[] }): {
  persist: boolean;
  confirm: boolean;
} {
  if (checks.ok) return { persist: true, confirm: true };
  if (
    extraction.date_source === "missing" &&
    checks.errors.every((e) => e === MISSING_DATE)
  ) {
    return { persist: true, confirm: false };
  }
  return { persist: false, confirm: false };
}

async function handleAwaitingDate(
  text: string,
  chatId: number,
  botToken: string,
  awaiting: { id: string; extraction: Extraction },
): Promise<APIGatewayProxyResultV2> {
  const today = todayToronto();
  const parsed = parseDateReply(text, today);
  if (!parsed) {
    await sendMessage(botToken, chatId, WAITING_DATE);
    return ok("ok");
  }

  const extraction: Extraction = {
    ...awaiting.extraction,
    date: parsed,
    date_source: "fix",
  };
  const taxonomy = await loadTaxonomy();
  const checks = validateExtraction(extraction, taxonomy);
  if (!checks.ok) {
    await sendMessage(botToken, chatId, formatPreview(extraction, checks));
    return ok("ok");
  }

  const applied = await applyIngestionDate(awaiting.id, extraction);
  if (!applied) {
    await sendMessage(botToken, chatId, "Already handled.");
    return ok("ok");
  }

  await sendCard(botToken, chatId, awaiting.id, extraction, checks);
  return ok("ok");
}

async function handleAwaitingEdit(
  text: string,
  chatId: number,
  config: Awaited<ReturnType<typeof getConfig>>,
  awaiting: { id: string; extraction: Extraction },
): Promise<APIGatewayProxyResultV2> {
  try {
    const today = todayToronto();
    const taxonomy = await loadTaxonomy();
    const extraction = await patchExtraction({
      apiKey: config.geminiApiKey,
      current: awaiting.extraction,
      correction: text,
      taxonomy,
      bucketRules: config.bucketRules,
      today,
    });
    const checks = validateExtraction(extraction, taxonomy);
    if (!previewOffer(extraction, checks).persist) {
      await sendMessage(config.botToken, chatId, formatPreview(extraction, checks));
      return ok("ok");
    }

    const applied = await applyIngestionEdit(awaiting.id, extraction);
    if (!applied) {
      await sendMessage(config.botToken, chatId, "Already handled.");
      return ok("ok");
    }

    await sendCard(config.botToken, chatId, awaiting.id, extraction, checks);
    return ok("ok");
  } catch (err) {
    console.error("edit extract error", err);
    await sendMessage(
      config.botToken,
      chatId,
      failureReply(err, "Couldn't apply that. Try again."),
    );
    return ok("ok");
  }
}

/** A saved row's card: the preview, any likely duplicate, and the buttons its checks allow. */
async function sendCard(
  botToken: string,
  chatId: number,
  ingestionId: string,
  extraction: Extraction,
  checks: CheckResult,
  position?: { index: number; count: number },
): Promise<void> {
  const { confirm } = previewOffer(extraction, checks);
  let duplicates: string[] = [];
  try {
    duplicates = duplicateWarnings(await findDuplicates(ingestionId));
  } catch (err) {
    // The row is saved: a card without the warning beats no card.
    console.error("duplicate check error", err);
  }
  // A warning only adds a line; Confirm still follows the checks alone.
  const shown = { ...checks, warnings: [...checks.warnings, ...duplicates] };
  await sendMessage(
    botToken,
    chatId,
    formatPreview(extraction, shown, position),
    reviewKeyboard(ingestionId, { confirm }),
  );
}

/** Resends the card of every pending row, e.g. one whose first send failed after saving. */
async function resendPendingCards(
  chatId: number,
  botToken: string,
): Promise<APIGatewayProxyResultV2> {
  const rows = await listPendingIngestions(chatId);
  if (rows.length === 0) {
    await sendMessage(botToken, chatId, NOTHING_PENDING);
    return ok("ok");
  }
  const taxonomy = await loadTaxonomy();
  for (const row of rows) {
    try {
      await sendCard(botToken, chatId, row.id, row.extraction, validateExtraction(row.extraction, taxonomy));
    } catch (err) {
      // One bad card must not hide the rest; /pending again retries it.
      console.error("card send error", err);
    }
  }
  return ok("ok");
}

/** Check, persist, and present every event of one message, in order. */
async function offerEvents(args: {
  update: TelegramUpdate;
  config: Awaited<ReturnType<typeof getConfig>>;
  source: "text" | "photo" | "voice";
  events: Extraction[];
  taxonomy: TaxonomySnapshot;
  media?: { bytes: Buffer; mimeType: string };
}): Promise<APIGatewayProxyResultV2> {
  const chatId = args.update.message!.chat.id;
  const usage = args.events.find((e) => e.usage)?.usage;
  const offers = args.events.map((extraction) => {
    const checks = validateExtraction(extraction, args.taxonomy);
    return { extraction, checks, offer: previewOffer(extraction, checks), id: crypto.randomUUID() };
  });
  const persisted = offers.filter((o) => o.offer.persist);
  const savedIds = new Map<(typeof offers)[number], string>();

  if (persisted.length > 0) {
    const mediaPath = args.media
      ? await putReceipt({
          bucket: args.config.receiptsBucket,
          ingestionId: persisted[0].id,
          body: args.media.bytes,
          contentType: args.media.mimeType,
        })
      : null;
    const rows: PendingIngestion[] = persisted.map((o, k) => ({
      id: o.id,
      source: args.source,
      mediaPath,
      telegramUpdateId: args.update.update_id,
      eventIndex: offers.indexOf(o),
      rawPayload: args.update,
      // Usage belongs to the shared calls: record it once, on the first saved event.
      extraction: { ...o.extraction, usage: k === 0 ? usage : undefined },
    }));
    const inserted = await insertPendingIngestions(rows);
    if (inserted === "duplicate") {
      return ok("duplicate");
    }
    // Buttons carry the id the database returned, as before.
    persisted.forEach((o, k) => savedIds.set(o, inserted[k].id));
  }

  for (const [index, o] of offers.entries()) {
    const position = { index, count: offers.length };
    const savedId = savedIds.get(o);
    try {
      if (savedId) {
        await sendCard(args.config.botToken, chatId, savedId, o.extraction, o.checks, position);
      } else {
        await sendMessage(args.config.botToken, chatId, formatPreview(o.extraction, o.checks, position));
      }
    } catch (err) {
      // Rows are saved: a "Couldn't parse" reply would make the owner resend and duplicate them.
      if (persisted.length === 0) throw err;
      console.error("card send error", err);
    }
  }
  return ok("ok");
}

async function handlePhoto(
  update: TelegramUpdate,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<APIGatewayProxyResultV2> {
  const message = update.message!;
  try {
    const file = await downloadTelegramFile(
      config.botToken,
      largestPhotoFileId(message.photo ?? []),
    );
    const today = todayToronto();
    const taxonomy = await loadTaxonomy();
    const events = (
      await extractFromPhoto({
        apiKey: config.geminiApiKey,
        image: file.bytes,
        mimeType: file.mimeType,
        caption: message.caption ?? "",
        taxonomy,
        bucketRules: config.bucketRules,
        today,
      })
    ).map((e) => withDatePolicy(normalizeTaxonomyNames(e, taxonomy), today, "photo"));
    return await offerEvents({ update, config, source: "photo", events, taxonomy, media: file });
  } catch (err) {
    console.error("photo extract error", err);
    await sendMessage(
      config.botToken,
      message.chat.id,
      failureReply(err, "Couldn't read that receipt. Try again."),
    );
    return ok("ok");
  }
}

async function handleVoice(
  update: TelegramUpdate,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<APIGatewayProxyResultV2> {
  const message = update.message!;
  try {
    const file = await downloadTelegramFile(
      config.botToken,
      voiceFileId(message.voice),
    );
    const today = todayToronto();
    const taxonomy = await loadTaxonomy();
    const events = (
      await extractFromVoice({
        apiKey: config.geminiApiKey,
        audio: file.bytes,
        mimeType: file.mimeType,
        caption: message.caption ?? "",
        taxonomy,
        bucketRules: config.bucketRules,
        today,
      })
    ).map((e) => withDatePolicy(normalizeTaxonomyNames(e, taxonomy), today, "voice"));
    return await offerEvents({ update, config, source: "voice", events, taxonomy, media: file });
  } catch (err) {
    console.error("voice extract error", err);
    await sendMessage(
      config.botToken,
      message.chat.id,
      failureReply(err, "Couldn't parse that voice note. Try again."),
    );
    return ok("ok");
  }
}

async function handleMessage(
  update: TelegramUpdate,
  config: Awaited<ReturnType<typeof getConfig>>,
): Promise<APIGatewayProxyResultV2> {
  const message = update.message!;
  if (!config.allowedChatIds.has(message.chat.id)) {
    return ok("ignored");
  }

  // Before the wait: "/pending" is never a date or a correction to send to Gemini.
  if (PENDING_COMMAND.test(message.text?.trim() ?? "")) {
    return await resendPendingCards(message.chat.id, config.botToken);
  }

  const awaiting = await findAwaitingIngestion();
  if (awaiting) {
    const waiting =
      awaiting.status === "awaiting_edit" ? WAITING_EDIT : WAITING_DATE;
    const text = message.text?.trim();
    if (!text) {
      await sendMessage(config.botToken, message.chat.id, waiting);
      return ok("ok");
    }
    if (awaiting.status === "awaiting_edit") {
      return await handleAwaitingEdit(
        text,
        message.chat.id,
        config,
        awaiting,
      );
    }
    return await handleAwaitingDate(
      text,
      message.chat.id,
      config.botToken,
      awaiting,
    );
  }

  if (message.photo?.length) {
    return await handlePhoto(update, config);
  }

  if (message.voice) {
    return await handleVoice(update, config);
  }

  const text = message.text?.trim();
  if (!text) {
    return ok("ignored");
  }

  try {
    const today = todayToronto();
    const taxonomy = await loadTaxonomy();
    const events = (
      await extractFromText({ apiKey: config.geminiApiKey, text, taxonomy, bucketRules: config.bucketRules, today })
    ).map((e) => withDatePolicy(normalizeTaxonomyNames(e, taxonomy), today));
    return await offerEvents({ update, config, source: "text", events, taxonomy });
  } catch (err) {
    console.error("extract error", err);
    await sendMessage(
      config.botToken,
      message.chat.id,
      failureReply(err, "Couldn't parse that. Try again in a sentence."),
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
    ack = result === "confirmed" ? withPosition("Saved.", cb.message?.text) : "Already handled.";
  } else if (action === "f") {
    const started = await setIngestionAwaitingDate(ingestionId);
    if (started === "busy") return busyWaiting(botToken, cb.id, chatId);
    ack = started === "started" ? "Send the date." : "Already handled.";
    await answerCallbackQuery(botToken, cb.id, ack);
    if (started === "started") {
      await sendMessage(
        botToken,
        chatId,
        ASK_DATE,
        reviewKeyboard(ingestionId, { confirm: false, edit: false }),
      );
    } else {
      await sendMessage(botToken, chatId, ack);
    }
    return ok("ok");
  } else if (action === "e") {
    const started = await setIngestionAwaitingEdit(ingestionId);
    if (started === "busy") return busyWaiting(botToken, cb.id, chatId);
    ack = started === "started" ? "Send the correction." : "Already handled.";
    await answerCallbackQuery(botToken, cb.id, ack);
    if (started === "started") {
      await sendMessage(
        botToken,
        chatId,
        ASK_EDIT,
        discardKeyboard(ingestionId),
      );
    } else {
      await sendMessage(botToken, chatId, ack);
    }
    return ok("ok");
  } else {
    const result = await discardIngestion(ingestionId);
    ack = result === "discarded" ? withPosition("Discarded.", cb.message?.text) : "Already handled.";
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
