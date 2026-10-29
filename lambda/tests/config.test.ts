import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send(command: unknown) {
      return send(command);
    }
  },
  GetParameterCommand: class {
    constructor(public input: { Name: string }) {}
  },
}));

const params: Record<string, string> = {
  "/finflow/telegram/bot-token": "tok",
  "/finflow/telegram/webhook-secret": "sec",
  "/finflow/telegram/allowed-chat-ids": "1, 2,,-3",
  "/finflow/supabase/database-url": "postgres://x",
  "/finflow/gemini/api-key": "key",
  "/finflow/bucket-rules": "",
};

type Cmd = { input: { Name: string } };

// config.ts caches at module level, so each test gets a fresh module.
async function load() {
  vi.resetModules();
  return (await import("../src/config.js")).getConfig;
}

beforeEach(() => {
  send.mockReset();
  send.mockImplementation(async (cmd: Cmd) => ({
    Parameter: { Value: params[cmd.input.Name] },
  }));
  vi.stubEnv("RECEIPTS_BUCKET", "bucket");
});

describe("getConfig", () => {
  it("loads parameters, parses chat ids, allows empty bucket rules", async () => {
    const cfg = await (await load())();
    expect(cfg.allowedChatIds).toEqual(new Set([1, 2, -3]));
    expect(cfg.bucketRules).toBe("");
    expect(cfg.receiptsBucket).toBe("bucket");
    expect(cfg.botToken).toBe("tok");
  });

  it("caches after the first load", async () => {
    const getConfig = await load();
    await getConfig();
    await getConfig();
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("rejects a missing or empty required parameter", async () => {
    send.mockImplementation(async (cmd: Cmd) => ({
      Parameter: { Value: cmd.input.Name.endsWith("bot-token") ? "" : "v" },
    }));
    await expect((await load())()).rejects.toThrow(
      "Missing or empty SSM parameter: /finflow/telegram/bot-token",
    );
  });

  it("rejects a non-integer chat id", async () => {
    send.mockImplementation(async (cmd: Cmd) => ({
      Parameter: {
        Value: cmd.input.Name.endsWith("allowed-chat-ids")
          ? "1,abc"
          : params[cmd.input.Name],
      },
    }));
    await expect((await load())()).rejects.toThrow("Invalid chat id");
  });

  it("rejects when RECEIPTS_BUCKET is unset", async () => {
    vi.stubEnv("RECEIPTS_BUCKET", "");
    await expect((await load())()).rejects.toThrow("Missing RECEIPTS_BUCKET");
  });
});
