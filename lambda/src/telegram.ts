import { commandMenu } from "./commands.js";

/**
 * Telegram answered and refused the call (an HTTP error status or ok=false),
 * so it did not happen. A network error or timeout is not one of these: the
 * call may have gone through.
 */
export class TelegramError extends Error {}

async function callTelegram(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok?: boolean; description?: string; result?: unknown }> {
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TelegramError(
      `Telegram ${method} HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }

  const data = (await res.json()) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  };
  if (!data.ok) {
    throw new TelegramError(
      `Telegram ${method} ok=false${data.description ? `: ${data.description}` : ""}`,
    );
  }
  return data;
}

async function postTelegram(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<void> {
  await callTelegram(botToken, method, body);
}

/**
 * `html`: the text is Telegram HTML (parse_mode HTML), with link previews off.
 * `silent`: delivered with no notification sound.
 * `thread`: the topic (message_thread_id) a sent message goes into; edits never take it.
 */
export type Format = { html?: boolean; silent?: boolean; thread?: number };

/**
 * The topic an incoming message is in. A thread id without the topic flag is
 * a reply chain in the main view, not a topic: it counts for nothing.
 */
export function topicThread(message: { message_thread_id?: number; is_topic_message?: boolean }): number | undefined {
  return message.is_topic_message ? message.message_thread_id : undefined;
}

function formatFields(format: Format): Record<string, unknown> {
  return {
    ...(format.html ? { parse_mode: "HTML", link_preview_options: { is_disabled: true } } : {}),
    ...(format.silent ? { disable_notification: true } : {}),
    ...(format.thread !== undefined ? { message_thread_id: format.thread } : {}),
  };
}

/**
 * Text made safe for an HTML message: Telegram's HTML mode needs `&`, `<`
 * and `>` as entities. Every name or description put in one goes through it.
 */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Sends a message; its message_id, when Telegram returns one. */
export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: object,
  format: Format = {},
): Promise<number | undefined> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    ...formatFields(format),
  };
  if (replyMarkup !== undefined) {
    body.reply_markup = replyMarkup;
  }
  const { result } = await callTelegram(botToken, "sendMessage", body);
  const id = (result as { message_id?: unknown } | undefined)?.message_id;
  return typeof id === "number" ? id : undefined;
}

/**
 * An edit. Telegram answers 400 "message is not modified" when the message
 * already shows the result (a retried or double tap), so that counts as done.
 */
async function postEdit(botToken: string, method: string, body: Record<string, unknown>): Promise<void> {
  try {
    await postTelegram(botToken, method, body);
  } catch (err) {
    if (!/message is not modified/.test((err as Error).message)) throw err;
  }
}

/** Replaces a sent message's inline keyboard; an empty one removes the buttons. */
export async function editMessageReplyMarkup(
  botToken: string,
  chatId: number,
  messageId: number,
  replyMarkup: { inline_keyboard: unknown[][] },
): Promise<void> {
  await postEdit(botToken, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

/** Replaces a sent message's text and its buttons; none by default. */
export async function editMessageText(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  keyboard: unknown[][] = [],
  format: Format = {},
): Promise<void> {
  await postEdit(botToken, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...formatFields(format),
    reply_markup: { inline_keyboard: keyboard },
  });
}

/** Deletes a sent message; Telegram refuses one older than 48 hours. */
export async function deleteMessage(botToken: string, chatId: number, messageId: number): Promise<void> {
  await postTelegram(botToken, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

/** Sets the bot's command menu to the command table. Run by the deploy workflow. */
export async function registerCommandMenu(botToken: string): Promise<void> {
  await postTelegram(botToken, "setMyCommands", { commands: commandMenu() });
}

/**
 * Topic mode: topics on, the owner may open topics, sidebar on. Idempotent,
 * run by the deploy workflow.
 */
export async function applyTopicSettings(botToken: string): Promise<void> {
  await postTelegram(botToken, "setMySettings", {
    has_topics_enabled: true,
    allows_users_to_create_topics: true,
    has_topic_sidebar: true,
  });
}

/** Opens a topic; its message_thread_id. Throws on refusal, callers decide what that costs. */
export async function createForumTopic(botToken: string, chatId: number, name: string): Promise<number> {
  const { result } = await callTelegram(botToken, "createForumTopic", { chat_id: chatId, name });
  const id = (result as { message_thread_id?: unknown } | undefined)?.message_thread_id;
  if (typeof id !== "number") throw new Error("createForumTopic returned no message_thread_id");
  return id;
}

/** Renames a topic. Throws on refusal. */
export async function editForumTopic(
  botToken: string,
  chatId: number,
  threadId: number,
  name: string,
): Promise<void> {
  await postTelegram(botToken, "editForumTopic", { chat_id: chatId, message_thread_id: threadId, name });
}

/** Deletes a topic and every message in it. Throws on refusal. */
export async function deleteForumTopic(botToken: string, chatId: number, threadId: number): Promise<void> {
  await postTelegram(botToken, "deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
}

/**
 * Deletes a topic the bot is done with, or renames it to `fallbackName` when
 * Telegram refuses the delete. Best effort: each refusal is logged, never thrown.
 */
export async function retireTopic(
  botToken: string,
  chatId: number,
  threadId: number,
  fallbackName: string,
): Promise<"deleted" | "renamed" | "failed"> {
  try {
    await deleteForumTopic(botToken, chatId, threadId);
    return "deleted";
  } catch (err) {
    console.error("topic delete refused", err);
  }
  try {
    await editForumTopic(botToken, chatId, threadId, fallbackName);
    return "renamed";
  } catch (err) {
    console.error("topic rename refused", err);
    return "failed";
  }
}

let cachedUsername: string | undefined;

/** The bot's @username, read once per warm container. */
export async function botUsername(botToken: string): Promise<string> {
  if (cachedUsername === undefined) {
    const { result } = await callTelegram(botToken, "getMe", {});
    const name = (result as { username?: unknown } | undefined)?.username;
    if (typeof name !== "string") throw new Error("getMe returned no username");
    cachedUsername = name;
  }
  return cachedUsername;
}

export function topicLink(botUsername: string, threadId: number): string {
  return `https://t.me/${botUsername}/${threadId}`;
}

export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };
  if (text !== undefined) {
    body.text = text;
  }
  // Best effort: a refusal ("query is too old" on a tap that queued) must not
  // skip the rest of the tap, or 500 and make Telegram resend it forever.
  try {
    await postTelegram(botToken, "answerCallbackQuery", body);
  } catch (err) {
    console.error("callback answer error", err);
  }
}

type Button = { text: string; callback_data: string };
/** A button that only shows a state: Telegram greys it out and sends nothing on a tap. */
type InertButton = { text: string; disabled: Record<string, never> };

/** The card's series button: `↻ Internet bill ✓` while Confirm links it, `↻ not Internet bill` once turned off. */
function seriesLabel(name: string, linking: boolean): string {
  const short = name.length <= 30 ? name : `${name.slice(0, 29).trimEnd()}…`;
  return linking ? `↻ ${short} ✓` : `↻ not ${short}`;
}

/**
 * A card's buttons. With a proposed series, Confirm links to it
 * (`cr:<card>:<series>`) and a last row toggles it (`rt:<card>:<series>`);
 * otherwise Confirm is `c:<card>`.
 */
export function reviewKeyboard(
  ingestionId: string,
  options: { confirm?: boolean; edit?: boolean; series?: { id: number; name: string } } = {},
): { inline_keyboard: Button[][] } {
  const confirm = options.confirm ?? true;
  const edit = options.edit ?? true;
  const series = confirm ? options.series : undefined;
  const first: Button[] = [];
  if (confirm) {
    const data = series ? `cr:${ingestionId}:${series.id}` : `c:${ingestionId}`;
    first.push({ text: "Confirm", callback_data: data });
  }
  first.push({ text: "Discard", callback_data: `d:${ingestionId}` });
  const second: Button[] = [
    { text: "Fix date", callback_data: `f:${ingestionId}` },
  ];
  if (edit) {
    second.push({ text: "Edit", callback_data: `e:${ingestionId}` });
  }
  const rows = [first, second];
  if (series) {
    rows.push([{ text: seriesLabel(series.name, true), callback_data: `rt:${ingestionId}:${series.id}` }]);
  }
  return { inline_keyboard: rows };
}

/**
 * The card's series toggle tapped: Confirm swaps between linking (`cr:`) and
 * "not this series" (`cx:`), and the toggle's label follows. The state lives
 * in the keyboard only; nothing is stored until Confirm.
 */
export function toggleCardSeries<B extends { text: string; callback_data?: string }>(keyboard: B[][]): B[][] {
  // A late tap on a saved card carries its ✅ Saved button, which has no callback_data: nothing to toggle.
  const linking = keyboard.flat().some((b) => b.callback_data?.startsWith("cr:"));
  return keyboard.map((row) =>
    row.map((b) => {
      if (!b.callback_data) return b;
      if (b.callback_data.startsWith("rt:")) {
        const name = linking ? b.text.slice("↻ ".length, -" ✓".length) : b.text.slice("↻ not ".length);
        return { ...b, text: seriesLabel(name, !linking) };
      }
      if (/^c[rx]:/.test(b.callback_data)) {
        return { ...b, callback_data: `${linking ? "cx" : "cr"}${b.callback_data.slice(2)}` };
      }
      return b;
    }),
  );
}

/** A confirmed card's keyboard. Disabled with no callback_data, so it is shown greyed and a tap sends nothing. */
export function savedCardKeyboard(): { inline_keyboard: InertButton[][] } {
  return { inline_keyboard: [[{ text: "✅ Saved", disabled: {} }]] };
}

/**
 * Buttons on a date or correction wait prompt. Keep as is returns the card to
 * `pending` and resends it; Discard drops the row. No Fix date here: the owner
 * is already waiting for a date, and tapping it would only say it was already handled.
 * `k:` / `d:` + uuid stay well under Telegram's 64-byte callback_data limit.
 */
export function waitingKeyboard(ingestionId: string): { inline_keyboard: Button[][] } {
  return {
    inline_keyboard: [
      [
        { text: "Keep as is", callback_data: `k:${ingestionId}` },
        { text: "Discard", callback_data: `d:${ingestionId}` },
      ],
    ],
  };
}

export function largestPhotoFileId(photos: unknown[]): string {
  let bestId: string | undefined;
  let bestSize = -1;
  for (const raw of photos) {
    if (!raw || typeof raw !== "object") continue;
    const photo = raw as { file_id?: unknown; file_size?: unknown };
    if (typeof photo.file_id !== "string" || photo.file_id === "") continue;
    const size = typeof photo.file_size === "number" ? photo.file_size : -1;
    if (bestId === undefined || size >= bestSize) {
      bestId = photo.file_id;
      bestSize = size;
    }
  }
  if (!bestId) throw new Error("no photo file_id");
  return bestId;
}

export function voiceFileId(voice: unknown): string {
  if (!voice || typeof voice !== "object") {
    throw new Error("no voice file_id");
  }
  const id = (voice as { file_id?: unknown }).file_id;
  if (typeof id !== "string" || id === "") {
    throw new Error("no voice file_id");
  }
  return id;
}

export function mimeTypeForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".oga") || lower.endsWith(".ogg")) return "audio/ogg";
  return "image/jpeg";
}

export type TelegramFile = {
  bytes: Buffer;
  mimeType: string;
};

export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<TelegramFile> {
  const data = await callTelegram(botToken, "getFile", { file_id: fileId });
  const filePath =
    data.result && typeof data.result === "object"
      ? (data.result as { file_path?: unknown }).file_path
      : undefined;
  if (typeof filePath !== "string" || filePath === "") {
    throw new Error("Telegram getFile missing file_path");
  }

  const res = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${filePath}`,
  );
  if (!res.ok) {
    throw new Error(`Telegram file HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mimeType: mimeTypeForPath(filePath) };
}
