import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const ALL_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

describe("when something goes wrong", () => {
  it(
    "Gemini overloaded on every model: the bot says so and saves nothing",
    { timeout: 15_000 },
    async () => {
      gemini.extract = golden("text-with-note").recorded;
      gemini.overloaded = new Set(ALL_MODELS);
      await chat.text("14 lunch at Subway");

      expect(chat.last().text).toBe("Gemini is overloaded right now. Send it again in a minute.");
      expect(gemini.calls.map((c) => c.model)).toEqual(ALL_MODELS);
      expect(await ledger.ingestions()).toEqual([]);
    },
  );

  it(
    "only the lighter model answered: the card says to check categories and buckets",
    { timeout: 15_000 },
    async () => {
      gemini.extract = golden("text-with-note").recorded;
      gemini.overloaded = new Set(ALL_MODELS.slice(0, 2));
      await chat.text("14 lunch at Subway on Oct 25, was too tired to pack lunch");

      expect(chat.last().text).toContain(
        "! read by a lighter model while Gemini was busy — check categories and buckets",
      );
      expect(chat.last().buttons.map((b) => b.text)).toContain("Confirm");
    },
  );

  it("Gemini finds no purchase: the bot asks to try again in a sentence", async () => {
    gemini.extract = { events: [] };
    await chat.text("hello");

    expect(chat.last().text).toBe("Couldn't parse that. Try again in a sentence.");
    expect(await ledger.ingestions()).toEqual([]);
  });

  it("a card that fails to send after saving does not stop the next card or blame the message", async () => {
    gemini.extract = golden("two-stores").recorded;
    chat.failNextSends(1);
    await chat.text("3 at Dollarama and 5 at Pharmaprix");

    const received = chat.replies();
    expect(received).toHaveLength(1);
    expect(received[0].text.split("\n")[0]).toMatch(/\(2 of 2\)$/);
    expect(received.some((r) => r.text.startsWith("Couldn't"))).toBe(false);
    expect(await ledger.ingestions()).toHaveLength(2);
  });
});
