import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { closeHelpers, resetData, sql } from "../integration/db-helpers.js";
import { testDbUrl } from "../integration/env.js";

/**
 * The deployed handler, end to end, with every outside service faked:
 * Telegram and Gemini through MSW (any other request, or a payload the real
 * Telegram would refuse, fails the journey), S3
 * through aws-sdk-client-mock, Postgres as the throwaway test database.
 */

export const OWNER = 1001;
export const STRANGER = 2002;
const SECRET = "journey-secret";
export const BUCKET = "journey-receipts";

export function journeyConfig() {
  return {
    botToken: "journey-token",
    webhookSecret: SECRET,
    allowedChatIds: new Set([OWNER]),
    databaseUrl: testDbUrl(),
    geminiApiKey: "journey-key",
    bucketRules: "",
    receiptsBucket: BUCKET,
  };
}

type Sent = { method: string; body: Record<string, unknown>; failed: boolean };

/** file_id -> file_path of the media the next message carries; getFile knows nothing else. */
const telegram = {
  sent: [] as Sent[],
  failSends: 0,
  files: {} as Record<string, string>,
  rejected: [] as string[],
};

type Button = { text?: string; callback_data?: string };

/** The Bot API limits the real Telegram enforces with HTTP 400. */
function telegramViolation(method: string, body: Record<string, unknown>): string | null {
  if (method === "sendMessage") {
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length < 1 || text.length > 4096) return "sendMessage: text must be 1-4096 characters";
    const markup = body.reply_markup as { inline_keyboard?: Button[][] } | undefined;
    for (const button of (markup?.inline_keyboard ?? []).flat()) {
      const bytes = Buffer.byteLength(button.callback_data ?? "", "utf8");
      if (bytes < 1 || bytes > 64) return "sendMessage: button callback_data must be 1-64 bytes";
      if (!button.text) return "sendMessage: button text must not be empty";
    }
  }
  if (method === "answerCallbackQuery" && typeof body.text === "string" && body.text.length > 200) {
    return "answerCallbackQuery: text must be at most 200 characters";
  }
  return null;
}

/** Requests no fake handles: blocked, and any left over fail the journey. */
const stray: string[] = [];

export function takeStrayRequests(): string[] {
  return stray.splice(0);
}

/** Payloads the real Telegram would refuse; any left over fail the journey. */
export function takeTelegramRejections(): string[] {
  return telegram.rejected.splice(0);
}

type GeminiCall = { model: string; kind: "extract" | "patch" };

/** Scripted Gemini: set `extract` / `patch` per journey. */
export const gemini = {
  calls: [] as GeminiCall[],
  extract: undefined as unknown,
  patch: undefined as unknown,
  overloaded: new Set<string>(),
};

function geminiReply(data: unknown) {
  return HttpResponse.json({
    candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
  });
}

type GeminiRequest = {
  contents: { parts: { text?: string }[] }[];
  generationConfig: { responseSchema: { properties: Record<string, unknown> } };
};

const server = setupServer(
  http.post("https://api.telegram.org/:bot/:method", async ({ request, params }) => {
    const method = String(params.method);
    const body = (await request.json()) as Record<string, unknown>;
    const violation = telegramViolation(method, body);
    if (violation) {
      telegram.rejected.push(violation);
      telegram.sent.push({ method, body, failed: true });
      return HttpResponse.json({ ok: false, description: `Bad Request: ${violation}` }, { status: 400 });
    }
    const failed = method === "sendMessage" && telegram.failSends > 0;
    if (failed) telegram.failSends--;
    telegram.sent.push({ method, body, failed });
    if (failed) {
      return HttpResponse.json({ ok: false, description: "Bad Gateway" }, { status: 502 });
    }
    if (method === "getFile") {
      const filePath = telegram.files[String(body.file_id)];
      if (!filePath) {
        const unknown = `getFile: no such file_id ${String(body.file_id)}`;
        telegram.rejected.push(unknown);
        return HttpResponse.json({ ok: false, description: `Bad Request: ${unknown}` }, { status: 400 });
      }
      return HttpResponse.json({ ok: true, result: { file_path: filePath } });
    }
    return HttpResponse.json({ ok: true, result: {} });
  }),
  http.get("https://api.telegram.org/file/:bot/*", () =>
    new HttpResponse(Buffer.from("journey-media")),
  ),
  http.post(
    "https://generativelanguage.googleapis.com/v1beta/models/:call",
    async ({ request, params }) => {
      const model = String(params.call).split(":")[0];
      const body = (await request.json()) as GeminiRequest;
      const props = body.generationConfig.responseSchema.properties;
      const kind = props.events ? "extract" : "patch";
      gemini.calls.push({ model, kind });
      if (gemini.overloaded.has(model)) {
        return HttpResponse.json({ error: { message: "overloaded" } }, { status: 503 });
      }
      const data = kind === "extract" ? gemini.extract : gemini.patch;
      if (data === undefined) {
        return HttpResponse.json(
          { error: { message: `no scripted ${kind} reply` } },
          { status: 400 },
        );
      }
      return geminiReply(data);
    },
  ),
);

const s3 = mockClient(S3Client);

export function uploads() {
  return s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
}

/** Registers the fakes and a clean database for every journey in the file. */
export function useJourneys(): void {
  beforeAll(() =>
    server.listen({
      onUnhandledRequest: (request, print) => {
        stray.push(`${request.method} ${request.url}`);
        print.error();
        // Logging alone lets the request through to the real network.
        throw new Error(`blocked unhandled request ${request.method} ${request.url}`);
      },
    }),
  );
  afterEach(() => {
    expect(takeStrayRequests(), "requests no fake handles").toEqual([]);
    expect(takeTelegramRejections(), "payloads Telegram would refuse").toEqual([]);
  });
  beforeEach(async () => {
    stray.length = 0;
    telegram.rejected = [];
    telegram.sent = [];
    telegram.failSends = 0;
    telegram.files = {};
    gemini.calls = [];
    gemini.extract = undefined;
    gemini.patch = undefined;
    gemini.overloaded = new Set();
    s3.reset();
    s3.on(PutObjectCommand).resolves({});
    await resetData();
  });
  afterAll(async () => {
    server.close();
    s3.restore();
    const db = await import("../../src/db.js");
    await db.closePool();
    await closeHelpers();
  });
}

export type Reply = { text: string; buttons: { text: string; data: string }[] };

function toReply(s: Sent): Reply {
  const markup = s.body.reply_markup as
    | { inline_keyboard?: { text: string; callback_data: string }[][] }
    | undefined;
  return {
    text: String(s.body.text),
    buttons: (markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => ({ text: b.text, data: b.callback_data })),
  };
}

export function labels(reply: Reply): string[] {
  return reply.buttons.map((b) => b.text);
}

type Result = { statusCode: number; body: string };

let updateId = 7000;
let callbackId = 0;
let last: unknown;

async function deliver(update: unknown, secret = SECRET): Promise<Result> {
  last = update;
  const { handler } = await import("../../src/handler.js");
  const event = {
    headers: { "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
  return (await handler(event)) as Result;
}

function message(fields: Record<string, unknown>, from = OWNER) {
  updateId++;
  return {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: from }, ...fields },
  };
}

/** The owner's side of the Telegram chat. */
export const chat = {
  text(text: string, from = OWNER) {
    return deliver(message({ text }, from));
  },
  photo(caption = "") {
    telegram.files = { "photo-large": "photos/file_1.jpg" };
    const photo = [
      { file_id: "photo-small", file_size: 10 },
      { file_id: "photo-large", file_size: 900 },
    ];
    return deliver(message(caption ? { photo, caption } : { photo }));
  },
  voice() {
    telegram.files = { "voice-1": "voice/file_2.oga" };
    return deliver(message({ voice: { file_id: "voice-1", duration: 4 } }));
  },
  tap(reply: Reply, label: string, from = OWNER) {
    const button = reply.buttons.find((b) => b.text === label);
    if (!button) {
      throw new Error(`no "${label}" button on: ${reply.text.split("\n")[0]}`);
    }
    return deliver({
      update_id: ++updateId,
      callback_query: {
        id: `cb-${++callbackId}`,
        data: button.data,
        message: { message_id: 1, chat: { id: from } },
      },
    });
  },
  /** Telegram resending the last update, as it does when a webhook call times out. */
  retry() {
    return deliver(last);
  },
  withSecret(secret: string, text: string) {
    return deliver(message({ text }), secret);
  },
  failNextSends(n: number) {
    telegram.failSends = n;
  },
  /** Bot messages the owner actually received, in order. */
  replies(): Reply[] {
    return telegram.sent
      .filter((s) => s.method === "sendMessage" && !s.failed)
      .map(toReply);
  },
  last(): Reply {
    const all = chat.replies();
    return all[all.length - 1];
  },
  /** The short pop-up texts shown when a button is tapped. */
  acks(): string[] {
    return telegram.sent
      .filter((s) => s.method === "answerCallbackQuery")
      .map((s) => String(s.body.text ?? ""));
  },
};

export const ledger = {
  ingestions() {
    return sql<{
      id: string;
      event_index: number;
      status: string;
      source: string;
      media_path: string | null;
    }>(
      `select id::text, event_index, status, source, media_path
       from ingestions order by created_at, event_index`,
    );
  },
  transactions() {
    return sql<Record<string, unknown>>(
      `select t.occurred_on::text as date, t.type::text, t.amount::text,
              t.description, t.notes, m.name as merchant, f.name as funder,
              s.name as income_source, a.name as account,
              (select count(*)::int from transaction_items i where i.transaction_id = t.id) as lines
       from transactions t
       left join merchants m on m.id = t.merchant_id
       left join funding_sources f on f.id = t.funding_source_id
       left join income_sources s on s.id = t.income_source_id
       left join accounts a on a.id = t.to_account_id
       order by t.created_at, t.amount`,
    );
  },
  items() {
    return sql<{ description: string; bucket: string }>(
      `select description, bucket::text from transaction_items order by description`,
    );
  },
};

export function todayToronto(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
