import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  addReply,
  cleanMerchantName,
  collapseSpaces,
  DELETE_USAGE,
  deleteReply,
  formatMerchants,
  parseCommand,
  type CommandName,
} from "./commands.js";
import { getConfig } from "./config.js";
import {
  addMerchant,
  applyIngestionDate,
  applyIngestionEdit,
  confirmIngestion,
  deleteMerchant,
  discardIngestion,
  findAwaitingIngestion,
  findDuplicates,
  findFrequentMerchant,
  insertPendingIngestions,
  findMentions,
  linkMentions,
  listMerchants,
  listPendingIngestions,
  loadTaxonomy,
  type PendingIngestion,
  setIngestionAwaitingDate,
  setIngestionAwaitingEdit,
} from "./db.js";
import {
  applyDatePolicy,
  duplicateWarnings,
  FREQUENT_MERCHANT_MIN,
  merchantHint,
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
import {
  ALREADY_LINKED,
  linkedSummary,
  MERCHANT_GONE,
  mentionsMessage,
  NO_MORE,
  parseMentionTap,
  PICK_FIRST,
  selectAll,
  ticked,
  toggle,
  withoutMore,
  type Keyboard,
  type MentionTap,
} from "./mentions.js";
import { cardSeries, type CardSeries } from "./recurring-card.js";
import { handleRecurringTap, answerPrompt, parseRecurringTap, sendRecurringList } from "./recurring-menu.js";
import { putReceipt } from "./s3.js";
import {
  answerCallbackQuery,
  discardKeyboard,
  downloadTelegramFile,
  editMessageReplyMarkup,
  editMessageText,
  largestPhotoFileId,
  reviewKeyboard,
  sendMessage,
  toggleCardSeries,
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
  audio?: unknown;
  document?: unknown;
  /** Unix seconds. */
  date?: number;
  reply_to_message?: { text?: string; date?: number; from?: { is_bot?: boolean } };
};
type TelegramCallbackQuery = {
  id: string;
  data?: string;
  message?: TelegramMessage & { reply_markup?: { inline_keyboard?: Keyboard } };
};
type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

const CALLBACK_RE =
  /^([cdfe]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** Confirm on a card that proposed a series: `cr:` links it, `cx:` records "not this series". */
const CONFIRM_SERIES_RE =
  /^(cr|cx):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,10})$/;

/** The card's series toggle; it only edits the keyboard. */
const SERIES_TOGGLE_RE =
  /^rt:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,10}$/;

const SERIES_GONE = "Not linked: that recurring series is gone or no longer fits.";

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

/**
 * Removes the buttons of a card that Fix date or Edit will replace with a new
 * one. Its Confirm carries the series proposed for the old reading, so a tap
 * after the correction would link the corrected payment to that series. Best
 * effort: a failed clear is logged and the flow goes on.
 */
async function retireCard(botToken: string, chatId: number, messageId: number | undefined): Promise<void> {
  if (messageId === undefined) return;
  try {
    await editMessageReplyMarkup(botToken, chatId, messageId, { inline_keyboard: [] });
  } catch (err) {
    console.error("card retire error", err);
  }
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

/** A saved row's card: the preview, any likely duplicate or merchant hint, and the buttons its checks allow. */
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
  let hint: string | undefined;
  try {
    hint = merchantHint(await findFrequentMerchant(ingestionId, FREQUENT_MERCHANT_MIN));
  } catch (err) {
    console.error("merchant hint error", err);
  }
  // Only a card that can be confirmed proposes a series; a dateless one is
  // matched when its date comes back.
  let series: CardSeries | null = null;
  if (confirm) {
    try {
      series = await cardSeries(ingestionId, extraction);
    } catch (err) {
      console.error("recurring match error", err);
    }
  }
  // A warning or hint only adds a line; Confirm still follows the checks alone.
  const shown = { ...checks, warnings: [...checks.warnings, ...duplicates] };
  await sendMessage(
    botToken,
    chatId,
    formatPreview(extraction, shown, position, hint, series ?? undefined),
    reviewKeyboard(ingestionId, { confirm, series: series ?? undefined }),
  );
}

/** Resends the card of every pending row, e.g. one whose first send failed after saving. */
async function resendPendingCards(chatId: number, botToken: string): Promise<void> {
  const rows = await listPendingIngestions(chatId);
  if (rows.length === 0) {
    await sendMessage(botToken, chatId, NOTHING_PENDING);
    return;
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
}

/** Sends one page of the mention review; false when there is nothing to offer. */
async function offerMentions(
  botToken: string,
  chatId: number,
  merchantId: number,
  after: string | null,
): Promise<boolean> {
  const found = await findMentions(merchantId, after);
  if (!found || found.rows.length === 0) return false;
  const { text, keyboard } = mentionsMessage(merchantId, found.name, found, after !== null);
  await sendMessage(botToken, chatId, text, { inline_keyboard: keyboard });
  return true;
}

/**
 * A tap on the mention review. Ticks live in the message's own keyboard, so a
 * toggle only edits it; Link selected writes the ticked rows that still have no
 * merchant, after the owner picked each one (constraint 3).
 */
async function handleMentionTap(
  cb: TelegramCallbackQuery,
  tap: MentionTap,
  chatId: number,
  botToken: string,
): Promise<APIGatewayProxyResultV2> {
  const messageId = cb.message!.message_id!;
  const keyboard = cb.message?.reply_markup?.inline_keyboard ?? [];
  if (tap.kind === "toggle" || tap.kind === "all") {
    const next = tap.kind === "toggle" ? toggle(keyboard, cb.data!) : selectAll(keyboard);
    // Telegram refuses an edit that changes nothing.
    if (JSON.stringify(next) !== JSON.stringify(keyboard)) {
      await editMessageReplyMarkup(botToken, chatId, messageId, { inline_keyboard: next });
    }
    // Answered after the edit, so the button's spinner holds until the tick shows.
    await answerCallbackQuery(botToken, cb.id);
  } else if (tap.kind === "skip") {
    await answerCallbackQuery(botToken, cb.id, "Skipped.");
    await editMessageReplyMarkup(botToken, chatId, messageId, { inline_keyboard: [] });
  } else if (tap.kind === "more") {
    await answerCallbackQuery(botToken, cb.id);
    await editMessageReplyMarkup(botToken, chatId, messageId, { inline_keyboard: withoutMore(keyboard) });
    if (!(await offerMentions(botToken, chatId, tap.merchantId, tap.after))) {
      await sendMessage(botToken, chatId, NO_MORE);
    }
  } else {
    const picked = ticked(keyboard);
    if (picked.ids.length === 0) {
      await answerCallbackQuery(botToken, cb.id, PICK_FIRST);
      return ok("ok");
    }
    const result = await linkMentions(tap.merchantId, picked.ids);
    if (result && result.linked === 0) {
      // Every pick already has a merchant: most likely a retried or repeated
      // Link, so the summary the first one wrote stays.
      await answerCallbackQuery(botToken, cb.id, ALREADY_LINKED);
      return ok("ok");
    }
    await answerCallbackQuery(botToken, cb.id, result ? "Linked." : "Nothing linked.");
    const text = result
      ? linkedSummary({ name: result.name, linked: result.linked, picked: picked.ids.length, shown: picked.shown })
      : MERCHANT_GONE;
    await editMessageText(botToken, chatId, messageId, text);
  }
  return ok("ok");
}

type CommandContext = { chatId: number; botToken: string; args: string };

/** What each slash command does; the type makes a command with no entry here a compile error. */
const RUN: Record<CommandName, (c: CommandContext) => Promise<void>> = {
  pending: ({ chatId, botToken }) => resendPendingCards(chatId, botToken),
  merchants: async ({ chatId, botToken }) => {
    await sendMessage(botToken, chatId, formatMerchants(await listMerchants()));
  },
  // The typed command is the confirmation for the merchant and its exact-name links;
  // a row that only mentions it waits for the owner's pick in the review.
  addmerchant: async ({ chatId, botToken, args }) => {
    const clean = cleanMerchantName(args);
    if ("error" in clean) {
      await sendMessage(botToken, chatId, clean.error);
      return;
    }
    const result = await addMerchant(clean.name);
    await sendMessage(botToken, chatId, addReply(result));
    // The reply is sent: a failed offer must not 500, or Telegram resends the command.
    try {
      await offerMentions(botToken, chatId, result.id, null);
    } catch (err) {
      console.error("mention offer error", err);
    }
  },
  delmerchant: async ({ chatId, botToken, args }) => {
    const name = collapseSpaces(args);
    const reply = name === "" ? DELETE_USAGE : deleteReply(await deleteMerchant(name), name);
    await sendMessage(botToken, chatId, reply);
  },
  recurring: ({ chatId, botToken }) => sendRecurringList(botToken, chatId, todayToronto()),
};

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
          source: args.source as "photo" | "voice",
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

  // Before the wait: a command is never a date or a correction to send to Gemini.
  const command = parseCommand(message.text);
  if (command) {
    await RUN[command.name]({
      chatId: message.chat.id,
      botToken: config.botToken,
      args: command.args,
    });
    return ok("ok");
  }

  // Also before the wait: a text reply to a fresh /recurring prompt (rename,
  // pause end) is not a date or a correction. Anything else, including a
  // photo or an expense sent as a reply, falls through to extraction.
  if (await answerPrompt(message, message.chat.id, config.botToken, todayToronto())) {
    return ok("ok");
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

  const review = parseMentionTap(cb.data);
  if (review) return handleMentionTap(cb, review, chatId, botToken);

  const today = todayToronto();
  const recurring = parseRecurringTap(cb.data, today);
  if (recurring) {
    await handleRecurringTap(recurring, {
      botToken,
      chatId,
      callbackId: cb.id,
      messageId: cb.message!.message_id!,
      keyboard: cb.message?.reply_markup?.inline_keyboard ?? [],
      today,
    });
    return ok("ok");
  }

  if (SERIES_TOGGLE_RE.test(cb.data ?? "")) {
    const keyboard = cb.message?.reply_markup?.inline_keyboard ?? [];
    const next = toggleCardSeries(keyboard);
    // Telegram refuses an edit that changes nothing.
    if (JSON.stringify(next) !== JSON.stringify(keyboard)) {
      await editMessageReplyMarkup(botToken, chatId, cb.message!.message_id!, { inline_keyboard: next });
    }
    await answerCallbackQuery(botToken, cb.id);
    return ok("ok");
  }

  const withSeries = cb.data?.match(CONFIRM_SERIES_RE);
  const match = withSeries ?? cb.data?.match(CALLBACK_RE);
  if (!match) {
    await answerCallbackQuery(botToken, cb.id, "Unknown action.");
    return ok("ok");
  }

  const action = match[1];
  const ingestionId = match[2];

  let ack: string;
  let ackButtons: object | undefined;
  if (action === "c" || withSeries) {
    const series = withSeries ? { id: Number(withSeries[3]), link: action === "cr" } : undefined;
    const result = await confirmIngestion(ingestionId, series);
    if (result === "already_handled") {
      ack = "Already handled.";
    } else {
      ack = `${withPosition("Saved.", cb.message?.text)}${result.seriesGone ? ` ${SERIES_GONE}` : ""}`;
      // After the save, so it adds no step: one tap opens /recurring's add flow on this payment.
      if (result.looksRecurring) {
        ackButtons = {
          inline_keyboard: [[{ text: "↻ Track as recurring", callback_data: `r:at:${result.transactionId}` }]],
        };
      }
    }
  } else if (action === "f") {
    const started = await setIngestionAwaitingDate(ingestionId);
    if (started === "busy") return busyWaiting(botToken, cb.id, chatId);
    ack = started === "started" ? "Send the date." : "Already handled.";
    await answerCallbackQuery(botToken, cb.id, ack);
    if (started === "started") {
      await retireCard(botToken, chatId, cb.message?.message_id);
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
      await retireCard(botToken, chatId, cb.message?.message_id);
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
  await sendMessage(botToken, chatId, ack, ackButtons);
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
