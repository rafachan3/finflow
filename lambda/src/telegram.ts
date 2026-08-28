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
    throw new Error(
      `Telegram ${method} HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }

  const data = (await res.json()) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  };
  if (!data.ok) {
    throw new Error(
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

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: object,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (replyMarkup !== undefined) {
    body.reply_markup = replyMarkup;
  }
  await postTelegram(botToken, "sendMessage", body);
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
  await postTelegram(botToken, "answerCallbackQuery", body);
}

export function reviewKeyboard(
  ingestionId: string,
  options: { confirm: boolean } = { confirm: true },
): object {
  const row: { text: string; callback_data: string }[] = [];
  if (options.confirm) {
    row.push({ text: "Confirm", callback_data: `c:${ingestionId}` });
  }
  row.push({ text: "Discard", callback_data: `d:${ingestionId}` });
  row.push({ text: "Fix date", callback_data: `f:${ingestionId}` });
  return { inline_keyboard: [row] };
}

export function confirmDiscardKeyboard(ingestionId: string): object {
  return reviewKeyboard(ingestionId);
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
  const mimeType = filePath.toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";
  return { bytes, mimeType };
}
