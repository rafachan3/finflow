async function postTelegram(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<void> {
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

  const data = (await res.json()) as { ok?: boolean; description?: string };
  if (!data.ok) {
    throw new Error(
      `Telegram ${method} ok=false${data.description ? `: ${data.description}` : ""}`,
    );
  }
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

export function confirmDiscardKeyboard(ingestionId: string): object {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: `c:${ingestionId}` },
        { text: "Discard", callback_data: `d:${ingestionId}` },
      ],
    ],
  };
}
