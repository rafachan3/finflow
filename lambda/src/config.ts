import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

const PARAM_BOT_TOKEN = "/finflow/telegram/bot-token";
const PARAM_WEBHOOK_SECRET = "/finflow/telegram/webhook-secret";
const PARAM_ALLOWED_CHAT_IDS = "/finflow/telegram/allowed-chat-ids";
const PARAM_DATABASE_URL = "/finflow/supabase/database-url";
const PARAM_GEMINI_API_KEY = "/finflow/gemini/api-key";
const PARAM_BUCKET_RULES = "/finflow/bucket-rules";

export type Config = {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: Set<number>;
  databaseUrl: string;
  geminiApiKey: string;
  bucketRules: string;
};

let cached: Config | undefined;

function parseAllowedChatIds(raw: string): Set<number> {
  const ids = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (!Number.isInteger(n)) {
      throw new Error(`Invalid chat id in allowed-chat-ids: ${trimmed}`);
    }
    ids.add(n);
  }
  return ids;
}

async function getParameter(
  client: SSMClient,
  name: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<string> {
  const result = await client.send(
    new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }),
  );
  const value = result.Parameter?.Value;
  if (value === undefined || (!opts.allowEmpty && value === "")) {
    throw new Error(`Missing or empty SSM parameter: ${name}`);
  }
  return value ?? "";
}

async function loadConfig(): Promise<Config> {
  const client = new SSMClient({});
  const [
    botToken,
    webhookSecret,
    allowedRaw,
    databaseUrl,
    geminiApiKey,
    bucketRules,
  ] = await Promise.all([
    getParameter(client, PARAM_BOT_TOKEN),
    getParameter(client, PARAM_WEBHOOK_SECRET),
    getParameter(client, PARAM_ALLOWED_CHAT_IDS),
    getParameter(client, PARAM_DATABASE_URL),
    getParameter(client, PARAM_GEMINI_API_KEY),
    getParameter(client, PARAM_BUCKET_RULES, { allowEmpty: true }),
  ]);

  return {
    botToken,
    webhookSecret,
    allowedChatIds: parseAllowedChatIds(allowedRaw),
    databaseUrl,
    geminiApiKey,
    bucketRules,
  };
}

export async function getConfig(): Promise<Config> {
  if (!cached) {
    cached = await loadConfig();
  }
  return cached;
}
