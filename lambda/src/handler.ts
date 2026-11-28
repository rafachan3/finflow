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
  todayToronto,
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
  findIngestionByThread,
  oldestTransactionDate,
  insertPendingIngestions,
  findMentions,
  linkMentions,
  listMerchants,
  listPendingIngestions,
  loadTaxonomy,
  type PendingIngestion,
  restoreIngestionPending,
  setIngestionAwaitingDate,
  setIngestionAwaitingEdit,
  setIngestionCardMessage,
  setIngestionTopic,
  getIngestion,
  findSharingIngestion,
  registerUtilityTopic,
  takeStaleUtilityTopics,
} from "./db.js";
import {
  alreadyHandled,
  applyDatePolicy,
  dateWarnings,
  duplicateWarnings,
  FREQUENT_MERCHANT_MIN,
  merchantHint,
  formatPreview,
  MISSING_DATE,
  normalizeTaxonomyNames,
  parseDateReply,
  topicName,
  validateExtraction,
  type CheckResult,
  type Extraction,
  type TaxonomySnapshot,
} from "./extraction.js";
import { extractFromPhoto, extractFromText, extractFromVoice, patchExtraction, REASK_BUDGET_MS, transcribeVoice } from "./gemini.js";
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
import { handleDigestTap, parseDigestTap } from "./recurring-digest.js";
import { handleRecurringTap, answerPrompt, parseRecurringTap, savedKeyboard, sendRecurringList } from "./recurring-menu.js";
import { putReceipt } from "./s3.js";
import {
  answerCallbackQuery,
  botUsername,
  createForumTopic,
  downloadTelegramFile,
  editForumTopic,
  editMessageReplyMarkup,
  editMessageText,
  esc,
  largestPhotoFileId,
  retireTopic,
  reviewKeyboard,
  savedCardKeyboard,
  sendMessage,
  topicThread,
  toggleCardSeries,
  topicLink,
  voiceFileId,
  waitingKeyboard,
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
  /** The topic the message is in; none in the main view or before topics. */
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: unknown;
  forum_topic_edited?: unknown;
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
  /^([cdfek]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
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
  "Still waiting for a date for the previous item. Send YYYY-MM-DD, Aug 10, or yesterday — or tap Keep as is / Discard.";
const ASK_EDIT =
  "Send the correction — amount, category, a line, whatever is wrong.";
const WAITING_EDIT =
  "Still waiting for a correction for the previous item. Send the change — or tap Keep as is / Discard.";

const BUSY_WAITING =
  "Another card is waiting for a date or correction. Send it, or tap Keep as is / Discard on the waiting prompt, then try again.";

const NOTHING_PENDING = "No pending cards.";

const GEMINI_OVERLOADED =
  "Gemini is overloaded right now. Send it again in a minute.";

/** Server overload that survived generateJson's retries is not the owner's input. */
function failureReply(err: unknown, fallback: string): string {
  return err instanceof Error && /^Gemini HTTP 50[034]\b/.test(err.message)
    ? GEMINI_OVERLOADED
    : fallback;
}

const SAVE_FAILED = "Couldn't save this one — tap Confirm again, or Edit/Discard.";

/**
 * A lost or refused connection (SQLSTATE class 08, 53300 too many connections,
 * 57P01-57P03 shutdown, or a Node socket error), which Telegram's resend may get past.
 */
function connectionError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(08[0-9A-Z]{3}|53300|57P0[123]|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(code);
}

function ok(body: string): APIGatewayProxyResultV2 {
  return { statusCode: 200, body };
}

async function busyWaiting(
  botToken: string,
  callbackId: string,
  chatId: number,
  thread?: number,
): Promise<APIGatewayProxyResultV2> {
  await answerCallbackQuery(botToken, callbackId, "Finish the waiting card first.");
  await sendMessage(botToken, chatId, BUSY_WAITING, undefined, { thread });
  return ok("ok");
}

/**
 * Where the wait just started on `ingestionId` listens: the row's topic, else
 * the tapped card's. A prompt elsewhere would be answered where the wait does
 * not hear it.
 */
async function waitThread(ingestionId: string, tapped: number | undefined): Promise<number | undefined> {
  const awaiting = await findAwaitingIngestion();
  return (awaiting?.id === ingestionId ? awaiting.threadId : null) ?? tapped;
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

/** The reply to a tap or answer that comes too late: which purchase, and where it stands. */
async function handledAck(ingestionId: string): Promise<string> {
  const row = await getIngestion(ingestionId);
  return row ? alreadyHandled(topicName(row.extraction), row.status) : alreadyHandled();
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

type Awaiting = NonNullable<Awaited<ReturnType<typeof findAwaitingIngestion>>>;

/**
 * The card of a waiting row after its date or correction, in `thread`, the
 * topic the answer came in. A row from before topics answered inside a topic
 * no purchase owns adopts it, so the tidy-up never takes it for a topic with
 * no purchase; another purchase's topic is never adopted or renamed. The topic
 * is renamed only when the purchase's name changed; topic calls are best effort.
 */
async function sendCorrectedCard(
  botToken: string,
  chatId: number,
  awaiting: Awaiting,
  extraction: Extraction,
  checks: CheckResult,
  thread: number | undefined,
): Promise<void> {
  let rename = awaiting.ownTopic && topicName(extraction) !== topicName(awaiting.extraction);
  if (awaiting.threadId === null && thread !== undefined) {
    try {
      if ((await findIngestionByThread(chatId, thread)) === null) {
        await setIngestionTopic(awaiting.id, thread);
        rename = true;
      }
    } catch (err) {
      console.error("topic adopt error", err);
    }
  }
  await sendCard(botToken, chatId, awaiting.id, extraction, checks, { thread });
  if (rename && thread !== undefined) {
    try {
      await editForumTopic(botToken, chatId, thread, topicName(extraction));
    } catch (err) {
      console.error("topic rename error", err);
    }
  }
}

async function handleAwaitingDate(
  text: string,
  chatId: number,
  botToken: string,
  awaiting: Awaiting,
  thread?: number,
): Promise<APIGatewayProxyResultV2> {
  const today = todayToronto();
  const parsed = parseDateReply(text, today);
  if (!parsed) {
    await sendMessage(botToken, chatId, WAITING_DATE, waitingKeyboard(awaiting.id), { thread });
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
    await sendMessage(
      botToken,
      chatId,
      formatPreview(extraction, checks),
      waitingKeyboard(awaiting.id),
      { thread },
    );
    return ok("ok");
  }

  const applied = await applyIngestionDate(awaiting.id, extraction);
  if (!applied) {
    await sendMessage(botToken, chatId, await handledAck(awaiting.id), undefined, { thread });
    return ok("ok");
  }

  await sendCorrectedCard(botToken, chatId, awaiting, extraction, checks, thread);
  return ok("ok");
}

async function handleAwaitingEdit(
  text: string,
  chatId: number,
  config: Awaited<ReturnType<typeof getConfig>>,
  awaiting: Awaiting,
  from?: string,
  thread?: number,
): Promise<APIGatewayProxyResultV2> {
  try {
    const today = todayToronto();
    const taxonomy = await loadTaxonomy();
    const extraction = await patchExtraction({
      from,
      apiKey: config.geminiApiKey,
      current: awaiting.extraction,
      correction: text,
      taxonomy,
      bucketRules: config.bucketRules,
      today,
    });
    const checks = validateExtraction(extraction, taxonomy);
    if (!previewOffer(extraction, checks).persist) {
      await sendMessage(
        config.botToken,
        chatId,
        formatPreview(extraction, checks),
        waitingKeyboard(awaiting.id),
        { thread },
      );
      return ok("ok");
    }

    const applied = await applyIngestionEdit(awaiting.id, extraction);
    if (!applied) {
      await sendMessage(config.botToken, chatId, await handledAck(awaiting.id), undefined, { thread });
      return ok("ok");
    }

    await sendCorrectedCard(config.botToken, chatId, awaiting, extraction, checks, thread);
    return ok("ok");
  } catch (err) {
    console.error("edit extract error", err);
    await sendMessage(
      config.botToken,
      chatId,
      failureReply(err, "Couldn't apply that. Try again."),
      waitingKeyboard(awaiting.id),
      { thread },
    );
    return ok("ok");
  }
}

/** A voice note sent while a card waits for a correction: its transcript is the correction, applied as typed text is. */
async function handleAwaitingVoiceEdit(
  message: NonNullable<TelegramUpdate["message"]>,
  config: Awaited<ReturnType<typeof getConfig>>,
  awaiting: Awaiting,
): Promise<APIGatewayProxyResultV2> {
  const thread = topicThread(message);
  let text: string;
  let model: string;
  try {
    const file = await downloadTelegramFile(config.botToken, voiceFileId(message.voice));
    const heard = await transcribeVoice({
      apiKey: config.geminiApiKey,
      audio: file.bytes,
      mimeType: file.mimeType,
    });
    // A caption is part of what the owner said: it goes first, as in handleVoice.
    text = [message.caption?.trim(), heard.transcript].filter(Boolean).join("\n");
    model = heard.model;
    if (heard.tookMs > REASK_BUDGET_MS) {
      // Too little of the Lambda's 60 s is left for the patch: keep waiting.
      await sendMessage(
        config.botToken,
        message.chat.id,
        "That voice note took too long to read. Try again, or type the correction.",
        waitingKeyboard(awaiting.id),
        { thread },
      );
      return ok("ok");
    }
  } catch (err) {
    console.error("voice correction transcribe error", err);
    await sendMessage(
      config.botToken,
      message.chat.id,
      failureReply(err, "Couldn't read that voice note. Try again."),
      waitingKeyboard(awaiting.id),
      { thread },
    );
    return ok("ok");
  }
  if (!text) {
    await sendMessage(config.botToken, message.chat.id, WAITING_EDIT, waitingKeyboard(awaiting.id), { thread });
    return ok("ok");
  }
  return await handleAwaitingEdit(text, message.chat.id, config, awaiting, model, thread);
}

/**
 * A saved row's card: the preview, any implausible-date or likely-duplicate
 * warning, any merchant hint, and the buttons its checks allow. Sent in
 * `thread` when given; the row records the card's message id.
 */
async function sendCard(
  botToken: string,
  chatId: number,
  ingestionId: string,
  extraction: Extraction,
  checks: CheckResult,
  opts: { position?: { index: number; count: number }; thread?: number } = {},
): Promise<void> {
  const { confirm } = previewOffer(extraction, checks);
  let duplicates: string[] = [];
  try {
    duplicates = duplicateWarnings(await findDuplicates(ingestionId));
  } catch (err) {
    // The row is saved: a card without the warning beats no card.
    console.error("duplicate check error", err);
  }
  // Needs the ledger's oldest date only for the "before your first entry" check; without it the others still run.
  let oldest: string | null = null;
  try {
    oldest = await oldestTransactionDate();
  } catch (err) {
    console.error("oldest date error", err);
  }
  const dates = dateWarnings(extraction.date, todayToronto(), oldest);
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
  const shown = { ...checks, warnings: [...checks.warnings, ...dates, ...duplicates] };
  const messageId = await sendMessage(
    botToken,
    chatId,
    formatPreview(extraction, shown, opts.position, hint, series ?? undefined),
    reviewKeyboard(ingestionId, { confirm, series: series ?? undefined }),
    { thread: opts.thread },
  );
  if (messageId === undefined) return;
  try {
    await setIngestionCardMessage(ingestionId, messageId);
  } catch (err) {
    // The card is out; without its id only a later topic lookup misses it.
    console.error("card id store error", err);
  }
}

/**
 * A new topic for a further purchase of one message, opened by a line that
 * links back to the message's topic. Undefined when Telegram refuses the topic.
 */
async function openPurchaseTopic(
  botToken: string,
  chatId: number,
  extraction: Extraction,
  messageThread: number,
): Promise<number | undefined> {
  let thread: number;
  try {
    thread = await createForumTopic(botToken, chatId, topicName(extraction));
  } catch (err) {
    console.error("topic create error", err);
    return undefined;
  }
  try {
    const link = topicLink(await botUsername(botToken), messageThread);
    await sendMessage(botToken, chatId, `↩️ <a href="${link}">From your message</a>`, undefined, {
      html: true,
      silent: true,
      thread,
    });
  } catch (err) {
    console.error("topic link error", err);
  }
  return thread;
}

const WAITING_SUFFIX: Record<string, string> = {
  awaiting_date: " (waiting for a date)",
  awaiting_edit: " (waiting for a correction)",
};

/**
 * Lists the chat's open purchases, oldest first, each linked to its topic, in
 * the command's topic. A row with no topic of its own (from before topics, or
 * sharing another purchase's) gets one, and its old card's buttons go; a row
 * whose card never arrived gets it again in its topic. A pending row's card is
 * its Confirm card, a waiting row's its date/correction prompt; the wait is
 * unchanged. No card goes to the command's topic: the tidy-up deletes it.
 */
async function listOpenPurchases(chatId: number, botToken: string, thread?: number): Promise<void> {
  const rows = await listPendingIngestions(chatId);
  if (rows.length === 0) {
    await sendMessage(botToken, chatId, NOTHING_PENDING, undefined, { thread });
    return;
  }
  const taxonomy = await loadTaxonomy();
  let username: string | undefined;
  try {
    username = await botUsername(botToken);
  } catch (err) {
    console.error("bot username error", err);
  }
  const lines: string[] = [];
  for (const row of rows) {
    const name = topicName(row.extraction);
    let own = row.threadId ?? undefined;
    try {
      if (own === undefined) {
        // Cleared before the topic is stored, so any step failing below leaves the
        // thread or the card null and the next /pending resends the card.
        await setIngestionCardMessage(row.id, null);
        try {
          const created = await createForumTopic(botToken, chatId, name);
          await setIngestionTopic(row.id, created);
          own = created;
        } catch (err) {
          // The main view is never tidied away, so the card stays reachable there.
          console.error("topic create error", err);
        }
        // A waiting row's card already lost its buttons when the wait began.
        if (row.status === "pending") await retireCard(botToken, chatId, row.cardMessageId ?? undefined);
      }
      if (row.threadId === null || row.cardMessageId === null) {
        if (row.status === "awaiting_date") {
          await sendMessage(botToken, chatId, ASK_DATE, waitingKeyboard(row.id), { thread: own });
        } else if (row.status === "awaiting_edit") {
          await sendMessage(botToken, chatId, ASK_EDIT, waitingKeyboard(row.id), { thread: own });
        } else {
          await sendCard(botToken, chatId, row.id, row.extraction, validateExtraction(row.extraction, taxonomy), {
            thread: own,
          });
        }
      }
    } catch (err) {
      // One bad card must not hide the rest; /pending again retries it.
      console.error("card send error", err);
    }
    const label = own !== undefined && username ? `<a href="${topicLink(username, own)}">${esc(name)}</a>` : esc(name);
    lines.push(`• ${label}${WAITING_SUFFIX[row.status] ?? ""}`);
  }
  await sendMessage(botToken, chatId, ["Open purchases:", ...lines].join("\n"), undefined, { html: true, thread });
}

/** Sends one page of the mention review; false when there is nothing to offer. */
async function offerMentions(
  botToken: string,
  chatId: number,
  merchantId: number,
  after: string | null,
  thread?: number,
): Promise<boolean> {
  const found = await findMentions(merchantId, after);
  if (!found || found.rows.length === 0) return false;
  const { text, keyboard } = mentionsMessage(merchantId, found.name, found, after !== null);
  await sendMessage(botToken, chatId, text, { inline_keyboard: keyboard }, { thread });
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
    const thread = topicThread(cb.message!);
    if (!(await offerMentions(botToken, chatId, tap.merchantId, tap.after, thread))) {
      await sendMessage(botToken, chatId, NO_MORE, undefined, { thread });
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

type CommandContext = { chatId: number; botToken: string; args: string; thread?: number };

/** What each slash command does; the type makes a command with no entry here a compile error. */
const RUN: Record<CommandName, (c: CommandContext) => Promise<void>> = {
  pending: ({ chatId, botToken, thread }) => listOpenPurchases(chatId, botToken, thread),
  merchants: async ({ chatId, botToken, thread }) => {
    await sendMessage(botToken, chatId, formatMerchants(await listMerchants()), undefined, { thread });
  },
  // The typed command is the confirmation for the merchant and its exact-name links;
  // a row that only mentions it waits for the owner's pick in the review.
  addmerchant: async ({ chatId, botToken, args, thread }) => {
    const clean = cleanMerchantName(args);
    if ("error" in clean) {
      await sendMessage(botToken, chatId, clean.error, undefined, { thread });
      return;
    }
    const result = await addMerchant(clean.name);
    await sendMessage(botToken, chatId, addReply(result), undefined, { thread });
    // The reply is sent: a failed offer must not 500, or Telegram resends the command.
    try {
      await offerMentions(botToken, chatId, result.id, null, thread);
    } catch (err) {
      console.error("mention offer error", err);
    }
  },
  delmerchant: async ({ chatId, botToken, args, thread }) => {
    const name = collapseSpaces(args);
    const reply = name === "" ? DELETE_USAGE : deleteReply(await deleteMerchant(name), name);
    await sendMessage(botToken, chatId, reply, undefined, { thread });
  },
  recurring: ({ chatId, botToken, thread }) => sendRecurringList(botToken, chatId, todayToronto(), thread),
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

  // One topic holds one purchase. The first saved one keeps the topic the
  // message is in, unless an earlier purchase owns it (this update's rows have
  // no thread yet); every other one gets a topic of its own.
  const botToken = args.config.botToken;
  const messageThread = topicThread(args.update.message!);
  let keepThread = false;
  if (messageThread !== undefined && persisted.length > 0) {
    try {
      keepThread = (await findIngestionByThread(chatId, messageThread)) === null;
    } catch (err) {
      console.error("topic owner lookup error", err);
    }
  }

  for (const [index, o] of offers.entries()) {
    const position = { index, count: offers.length };
    const savedId = savedIds.get(o);
    try {
      if (!savedId) {
        await sendMessage(botToken, chatId, formatPreview(o.extraction, o.checks, position), undefined, {
          thread: messageThread,
        });
      } else if (messageThread === undefined) {
        await sendCard(botToken, chatId, savedId, o.extraction, o.checks, { position });
      } else if (keepThread) {
        keepThread = false;
        await setIngestionTopic(savedId, messageThread);
        await sendCard(botToken, chatId, savedId, o.extraction, o.checks, { position, thread: messageThread });
        try {
          await editForumTopic(botToken, chatId, messageThread, topicName(o.extraction));
        } catch (err) {
          console.error("topic rename error", err);
        }
      } else {
        // A refused topic leaves the card in the message's topic, and the row
        // with no thread: that topic stays its first purchase's alone.
        const thread = await openPurchaseTopic(botToken, chatId, o.extraction, messageThread);
        if (thread !== undefined) await setIngestionTopic(savedId, thread);
        await sendCard(botToken, chatId, savedId, o.extraction, o.checks, { position, thread: thread ?? messageThread });
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
      undefined,
      { thread: topicThread(message) },
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
      undefined,
      { thread: topicThread(message) },
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
  // Telegram's notice of a topic opened or renamed is not the owner's message.
  if (message.forum_topic_created || message.forum_topic_edited) {
    return ok("ignored");
  }

  // Before the wait: a command is never a date or a correction to send to Gemini.
  const thread = topicThread(message);
  const command = parseCommand(message.text);
  if (command) {
    await RUN[command.name]({
      chatId: message.chat.id,
      botToken: config.botToken,
      args: command.args,
      thread,
    });
    return ok("ok");
  }

  // Also before the wait: a text reply to a fresh /recurring prompt (rename,
  // pause end) is not a date or a correction. Anything else, including a
  // photo or an expense sent as a reply, falls through to extraction.
  if (await answerPrompt(message, message.chat.id, config.botToken, todayToronto())) {
    return ok("ok");
  }

  // A wait listens only in its own topic; elsewhere a message is a new purchase.
  // A row from before topics has none and takes the next message, as before.
  const found = await findAwaitingIngestion();
  const awaiting = found && (found.threadId === null || found.threadId === thread) ? found : null;
  if (awaiting) {
    const waiting =
      awaiting.status === "awaiting_edit" ? WAITING_EDIT : WAITING_DATE;
    const text = message.text?.trim();
    if (!text) {
      if (awaiting.status === "awaiting_edit" && message.voice) {
        return await handleAwaitingVoiceEdit(message, config, awaiting);
      }
      await sendMessage(
        config.botToken,
        message.chat.id,
        waiting,
        waitingKeyboard(awaiting.id),
        { thread },
      );
      return ok("ok");
    }
    if (awaiting.status === "awaiting_edit") {
      return await handleAwaitingEdit(
        text,
        message.chat.id,
        config,
        awaiting,
        undefined,
        thread,
      );
    }
    return await handleAwaitingDate(
      text,
      message.chat.id,
      config.botToken,
      awaiting,
      thread,
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
      undefined,
      { thread: topicThread(message) },
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

  const thread = topicThread(cb.message!);
  const review = parseMentionTap(cb.data);
  if (review) return handleMentionTap(cb, review, chatId, botToken);

  const today = todayToronto();
  const tapContext = () => ({
    botToken,
    chatId,
    callbackId: cb.id,
    messageId: cb.message!.message_id!,
    keyboard: cb.message?.reply_markup?.inline_keyboard ?? [],
    text: cb.message?.text,
    today,
    thread,
  });
  // The scheduled digest's buttons: the nudge function sends it, but every tap reaches this webhook.
  const digest = parseDigestTap(cb.data);
  if (digest) {
    await handleDigestTap(digest, tapContext());
    return ok("ok");
  }

  const recurring = parseRecurringTap(cb.data, today);
  if (recurring) {
    await handleRecurringTap(recurring, tapContext());
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
  if (action === "c" || withSeries) {
    const series = withSeries ? { id: Number(withSeries[3]), link: action === "cr" } : undefined;
    let result: Awaited<ReturnType<typeof confirmIngestion>>;
    try {
      result = await confirmIngestion(ingestionId, series);
    } catch (err) {
      // Any other error fails the same on every resend, and a 500 makes Telegram
      // resend it for minutes. The row stays pending with its buttons, so the
      // owner can tap Confirm again and nothing is lost.
      if (connectionError(err)) throw err;
      console.error("confirm save error", err);
      await answerCallbackQuery(botToken, cb.id, SAVE_FAILED);
      return ok("ok");
    }
    if (result === "already_handled") {
      ack = await handledAck(ingestionId);
    } else {
      const row = (await getIngestion(ingestionId))!;
      const gone = result.seriesGone ? ` ${SERIES_GONE}` : "";
      await answerCallbackQuery(botToken, cb.id, `Saved: ${topicName(row.extraction)}.${gone}`);
      // The purchase is already saved, so a refused edit must not skip the rest or make Telegram resend the tap.
      try {
        await editMessageReplyMarkup(botToken, chatId, cb.message!.message_id!, savedCardKeyboard());
      } catch (err) {
        console.error("saved card edit error", err);
      }
      // Only the purchase's own topic: a card from before topics, or one sharing another purchase's topic, renames none.
      if (row.threadId !== null) {
        try {
          await editForumTopic(botToken, chatId, row.threadId, topicName(row.extraction, "✅ "));
        } catch (err) {
          console.error("saved topic rename failed", err);
        }
      }
      // A message only when there is something to act on. It is not the card,
      // because the recurring add flow redraws the message its buttons are on.
      if (result.looksRecurring || result.seriesGone) {
        // After the save, so it adds no step: one tap adds it to the series it
        // fits by timing and amount, or opens /recurring's add flow on it.
        const buttons = result.looksRecurring ? { inline_keyboard: await savedKeyboard(result.transactionId) } : undefined;
        await sendMessage(botToken, chatId, `Saved.${gone}`, buttons, { thread: row.threadId ?? thread });
      }
      return ok("ok");
    }
  } else if (action === "f") {
    const started = await setIngestionAwaitingDate(ingestionId);
    if (started === "busy") return busyWaiting(botToken, cb.id, chatId, thread);
    ack = started === "started" ? "Send the date." : await handledAck(ingestionId);
    await answerCallbackQuery(botToken, cb.id, ack);
    if (started === "started") {
      await retireCard(botToken, chatId, cb.message?.message_id);
      await sendMessage(botToken, chatId, ASK_DATE, waitingKeyboard(ingestionId), { thread: await waitThread(ingestionId, thread) });
    } else {
      await sendMessage(botToken, chatId, ack, undefined, { thread });
    }
    return ok("ok");
  } else if (action === "e") {
    const started = await setIngestionAwaitingEdit(ingestionId);
    if (started === "busy") return busyWaiting(botToken, cb.id, chatId, thread);
    ack = started === "started" ? "Send the correction." : await handledAck(ingestionId);
    await answerCallbackQuery(botToken, cb.id, ack);
    if (started === "started") {
      await retireCard(botToken, chatId, cb.message?.message_id);
      await sendMessage(botToken, chatId, ASK_EDIT, waitingKeyboard(ingestionId), { thread: await waitThread(ingestionId, thread) });
    } else {
      await sendMessage(botToken, chatId, ack, undefined, { thread });
    }
    return ok("ok");
  } else if (action === "k") {
    // Keep as is: leave the wait, resend the Confirm card as stored. No Gemini.
    const restored = await restoreIngestionPending(ingestionId);
    if (!restored) {
      ack = await handledAck(ingestionId);
      await answerCallbackQuery(botToken, cb.id, ack);
      await sendMessage(botToken, chatId, ack, undefined, { thread });
      return ok("ok");
    }
    await answerCallbackQuery(botToken, cb.id, "Kept as is.");
    await retireCard(botToken, chatId, cb.message?.message_id);
    const taxonomy = await loadTaxonomy();
    await sendCard(
      botToken,
      chatId,
      restored.id,
      restored.extraction,
      validateExtraction(restored.extraction, taxonomy),
      { thread: restored.threadId ?? thread },
    );
    return ok("ok");
  } else {
    const result = await discardIngestion(ingestionId);
    if (result === "discarded") {
      const row = (await getIngestion(ingestionId))!;
      ack = `Discarded: ${topicName(row.extraction)}.`;
      await answerCallbackQuery(botToken, cb.id, ack);
      // Only the purchase's own topic goes: a card from before topics, or one
      // sharing another purchase's topic, has no thread and deletes nothing.
      if (row.threadId === null) {
        await sendMessage(botToken, chatId, ack, undefined, { thread });
        return ok("ok");
      }
      // A card whose own topic was refused sits here, maybe with its wait
      // prompt: the topic becomes that purchase's instead of going.
      const sharing = await findSharingIngestion(chatId, row.threadId);
      if (sharing) {
        await setIngestionTopic(sharing.id, row.threadId);
        try {
          await editForumTopic(botToken, chatId, row.threadId, topicName(sharing.extraction));
        } catch (err) {
          console.error("topic hand-over rename error", err);
        }
        await retireCard(botToken, chatId, cb.message?.message_id);
      } else if ((await retireTopic(botToken, chatId, row.threadId, topicName(row.extraction, "🗑 "))) !== "deleted") {
        await retireCard(botToken, chatId, cb.message?.message_id);
      }
      return ok("ok");
    }
    ack = await handledAck(ingestionId);
  }

  await answerCallbackQuery(botToken, cb.id, ack);
  await sendMessage(botToken, chatId, ack, undefined, { thread });
  return ok("ok");
}

/**
 * How long a command's or a no-purchase message's topic stays after the owner's
 * last message in it. No timer deletes it: the Lambda has no scheduler of its
 * own, the nudge's daily run has no business with topics, and a new schedule
 * is new infra. The owner messages daily, so the next message is the clock.
 */
const UTILITY_TOPIC_TTL_SECONDS = 60 * 60;

/** The owner's own message, not a stranger's or Telegram's topic notice: only these tidy topics. */
function tidiesTopics(message: TelegramMessage, allowedChatIds: Set<number>): boolean {
  return allowedChatIds.has(message.chat.id) && !message.forum_topic_created && !message.forum_topic_edited;
}

/**
 * Before the reply: a topic no purchase owns yet is noted for tidying, and a
 * message in one restarts its hour. A purchase the message brings takes the
 * topic over and drops the note. Best effort: it never changes the reply.
 */
async function noteUtilityTopic(message: TelegramMessage): Promise<void> {
  const thread = topicThread(message);
  if (thread === undefined) return;
  try {
    if ((await findIngestionByThread(message.chat.id, thread)) === null) {
      const command = parseCommand(message.text);
      await registerUtilityTopic(message.chat.id, thread, command ? `/${command.name}` : "No purchase");
    }
  } catch (err) {
    console.error("topic note error", err);
  }
}

/**
 * After the reply: deletes the noted topics past their hour, renamed ⚙️ when
 * Telegram refuses and never tried again. Best effort: it never changes the reply.
 */
async function sweepUtilityTopics(botToken: string, chatId: number): Promise<void> {
  try {
    for (const stale of await takeStaleUtilityTopics(chatId, UTILITY_TOPIC_TTL_SECONDS)) {
      await retireTopic(botToken, chatId, stale.threadId, `⚙️ ${stale.label}`);
    }
  } catch (err) {
    console.error("topic sweep error", err);
  }
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
      const tidy = tidiesTopics(update.message, config.allowedChatIds);
      // Noted before the reply, so another invocation's sweep never takes a topic in use.
      if (tidy) await noteUtilityTopic(update.message);
      const response = await handleMessage(update, config);
      if (tidy) await sweepUtilityTopics(config.botToken, update.message.chat.id);
      return response;
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
