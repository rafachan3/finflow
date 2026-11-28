import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, useJourneys, whileGeminiHangs } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
});

useJourneys();

const ALL_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

describe("when something goes wrong", () => {
  it("Gemini overloaded on every model: the bot says so and saves nothing", async () => {
    gemini.extract = golden("text-with-note").recorded;
    gemini.overloaded = new Set(ALL_MODELS);
    await chat.text("14 lunch at Sandwich Shop");

    expect(chat.last().text).toBe("Gemini is overloaded right now. Send it again in a minute.");
    expect(gemini.calls.map((c) => c.model)).toEqual(ALL_MODELS);
    expect(gemini.delays).toEqual([2000, 2000]);
    expect(await ledger.ingestions()).toEqual([]);
  });

  it("only the lighter model answered: the card says to check categories and buckets", async () => {
    gemini.extract = golden("text-with-note").recorded;
    gemini.overloaded = new Set(ALL_MODELS.slice(0, 2));
    await chat.text("14 lunch at Sandwich Shop on Oct 25, didnt pak it, was to tierd, my lunch i mean");

    expect(chat.last().text).toContain(
      "! read by a lighter model while Gemini was busy — check categories and buckets",
    );
    expect(chat.last().buttons.map((b) => b.text)).toContain("Confirm");
    expect(gemini.delays).toEqual([2000, 2000]);
  });

  it("a model that never answers is given up in time, and the last model still reads it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      gemini.extract = golden("text-with-note").recorded;
      gemini.hang = new Set([ALL_MODELS[0]]);
      const sent = Date.now();
      const answer = await whileGeminiHangs(chat.text("14 lunch at Sandwich Shop on Oct 25, didnt pak it, was to tierd, my lunch i mean"));

      expect(answer.statusCode).toBe(200);
      expect(Date.now() - sent).toBeLessThan(60_000);
      expect(gemini.calls.map((c) => c.model)).toEqual([ALL_MODELS[0], ALL_MODELS[2]]);
      expect(chat.last().text).toContain("! read by a lighter model while Gemini was busy");
      expect(chat.last().buttons.map((b) => b.text)).toContain("Confirm");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Gemini never answers on any model: the bot says so before the Lambda's deadline, with a 200 and nothing saved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      gemini.extract = golden("text-with-note").recorded;
      gemini.hang = new Set(ALL_MODELS);
      const sent = Date.now();
      const answer = await whileGeminiHangs(chat.text("14 lunch at Sandwich Shop"));

      // A 200 is what stops Telegram redelivering it and holding the chat's later updates.
      expect(answer.statusCode).toBe(200);
      expect(Date.now() - sent).toBeLessThan(60_000);
      expect(chat.last().text).toBe("Gemini is overloaded right now. Send it again in a minute.");
      expect(await ledger.ingestions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Gemini finds no purchase: the bot asks to try again in a sentence", async () => {
    gemini.extract = { events: [] };
    await chat.text("hello");

    expect(gemini.calls).toEqual([{ model: "gemini-3.6-flash", kind: "extract" }]);
    expect(chat.last().text).toBe("Couldn't parse that. Try again in a sentence.");
    expect(await ledger.ingestions()).toEqual([]);
  });

  it("an amount of 0.00 is shown as a failed check with no buttons, and nothing is saved", async () => {
    const recorded = golden("text-with-note").recorded as { events: Record<string, unknown>[] };
    const [event] = recorded.events;
    const [line] = event.items as Record<string, unknown>[];
    gemini.extract = { events: [{ ...event, amount: "0.00", items: [{ ...line, amount: "0.00" }] }] };
    await chat.text("lunch at Sandwich Shop");

    expect(chat.last().text).toContain("✗ amount must be more than 0.00, got 0.00");
    expect(labels(chat.last())).toEqual([]);
    expect(await ledger.ingestions()).toEqual([]);
    expect(await ledger.transactions()).toEqual([]);
  });

  it("a card that fails to send after saving does not stop the next card or blame the message", async () => {
    gemini.extract = golden("two-stores").recorded;
    chat.failNextSends(1);
    await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");

    const received = chat.replies();
    expect(received).toHaveLength(1);
    expect(received[0].text.split("\n")[0]).toMatch(/\(2 of 2\)$/);
    expect(received.some((r) => r.text.startsWith("Couldn't"))).toBe(false);
    expect(await ledger.ingestions()).toHaveLength(2);
  });
});
