import { describe, expect, it, vi } from "vitest";
import { sendMessage, answerCallbackQuery } from "../../src/telegram.js";
import { takeStrayRequests, takeTelegramRejections, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

describe("the journey fakes", () => {
  it("block and record a request no fake handles", async () => {
    // MSW answers a blocked request itself; the real host is never contacted.
    const res = await fetch("https://example.com/anything");
    expect([res.status, res.statusText]).toEqual([500, "Unhandled Exception"]);
    expect(takeStrayRequests()).toEqual(["GET https://example.com/anything"]);
  });

  it("reject a message longer than Telegram allows, as Telegram does", async () => {
    await expect(sendMessage("t", 1, "x".repeat(4097))).rejects.toThrow(/HTTP 400/);
    expect(takeTelegramRejections()).toEqual([
      "sendMessage: text must be 1-4096 characters",
    ]);
  });

  it("reject an empty message", async () => {
    await expect(sendMessage("t", 1, "")).rejects.toThrow(/HTTP 400/);
    expect(takeTelegramRejections()).toHaveLength(1);
  });

  it("reject button data over 64 bytes", async () => {
    const keyboard = { inline_keyboard: [[{ text: "Go", callback_data: "x".repeat(65) }]] };
    await expect(sendMessage("t", 1, "hi", keyboard)).rejects.toThrow(/HTTP 400/);
    expect(takeTelegramRejections()).toEqual([
      "sendMessage: button callback_data must be 1-64 bytes",
    ]);
  });

  it("reject a pop-up longer than 200 characters", async () => {
    await expect(answerCallbackQuery("t", "cb", "x".repeat(201))).rejects.toThrow(/HTTP 400/);
    expect(takeTelegramRejections()).toEqual([
      "answerCallbackQuery: text must be at most 200 characters",
    ]);
  });
});
