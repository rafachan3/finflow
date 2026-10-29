import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, todayToronto, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const REVIEW = ["Confirm", "Discard", "Fix date", "Edit"];

type Event = Record<string, unknown>;

/** The first recorded event of a golden case, with some fields changed. */
function event(file: string, index = 0, over: Event = {}): Event {
  const recorded = golden(file).recorded as { events: Event[] };
  return { ...recorded.events[index], ...over };
}

function warnings(text: string): string[] {
  return text.split("\n").filter((l) => /^! (Same photo|Possible duplicate)/.test(l));
}

describe("duplicate warning", () => {
  it("re-sending a confirmed receipt photo warns and keeps Confirm", async () => {
    gemini.extract = { events: [event("receipt-with-caption")] };
    await chat.photo();
    expect(warnings(chat.last().text)).toEqual([]);
    await chat.tap(chat.last(), "Confirm");

    const sentOn = todayToronto();
    await chat.photo();
    const card = chat.last();
    expect(warnings(card.text)).toEqual([`! Same photo as a card from ${sentOn} (saved)`]);
    expect(card.text).toContain("Confirm to save");
    expect(labels(card)).toEqual(REVIEW);
  });

  it("a second paycheck of the same amount within 3 days warns, and the next one 14 days later does not", async () => {
    const paycheck = (date: string) => ({ events: [event("expense-and-income", 1, { date })] });
    gemini.extract = paycheck("2026-10-16");
    await chat.text("got paid 200");
    await chat.tap(chat.last(), "Confirm");

    gemini.extract = paycheck("2026-10-19");
    await chat.text("got paid 200");
    expect(warnings(chat.last().text)).toEqual([
      '! Possible duplicate: CAD 200.00 on 2026-10-16, "Salary" (saved)',
    ]);
    await chat.tap(chat.last(), "Discard");

    gemini.extract = paycheck("2026-10-30");
    await chat.text("got paid 200");
    expect(warnings(chat.last().text)).toEqual([]);
  });

  it("a transfer logged twice warns", async () => {
    gemini.extract = golden("transfer").recorded;
    await chat.text("moved 50 to my emergency fund on Oct 26");
    await chat.tap(chat.last(), "Confirm");

    await chat.text("moved 50 to my emergency fund on Oct 26");
    expect(warnings(chat.last().text)).toEqual([
      '! Possible duplicate: CAD 50.00 on 2026-10-26, "Transfer to emergency fund" (saved)',
    ]);
    expect(labels(chat.last())).toEqual(REVIEW);
  });

  it("a purchase still pending warns the next identical one", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25");
    await chat.text("14 lunch at Sandwich Shop on Oct 25");

    expect(warnings(chat.last().text)).toEqual([
      '! Possible duplicate: CAD 14.00 on 2026-10-25, "Lunch at Sandwich Shop" (still pending)',
    ]);
    expect(await ledger.transactions()).toEqual([]);
  });

  it("events of one message do not warn each other", async () => {
    const lunch = event("text-with-note");
    gemini.extract = { events: [lunch, lunch] };
    await chat.text("14 lunch at Sandwich Shop on Oct 25, and again for a friend");

    const cards = chat.replies();
    expect(cards).toHaveLength(2);
    expect(cards.flatMap((c) => warnings(c.text))).toEqual([]);
  });

  it("a Fix date that moves a card next to a saved purchase warns on the new card", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25");
    await chat.tap(chat.last(), "Confirm");

    gemini.extract = { events: [event("text-with-note", 0, { date: "2026-10-01" })] };
    await chat.text("14 lunch at Sandwich Shop on Oct 1");
    expect(warnings(chat.last().text)).toEqual([]);

    await chat.tap(chat.last(), "Fix date");
    await chat.text("2026-10-26");
    expect(warnings(chat.last().text)).toEqual([
      '! Possible duplicate: CAD 14.00 on 2026-10-25, "Lunch at Sandwich Shop" (saved)',
    ]);
    expect(labels(chat.last())).toEqual(REVIEW);
  });
});
