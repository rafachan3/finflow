import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, todayToronto, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
});

useJourneys();

const REVIEW = ["Confirm", "Discard", "Fix date", "Edit"];

/** Today (Toronto) moved by whole days. */
function daysFromToday(days: number): string {
  const [y, m, d] = todayToronto().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A recorded lunch event with its date changed. */
function lunchOn(date: string | null): { events: object[] } {
  const recorded = golden("text-with-note").recorded as { events: object[] };
  return { events: [{ ...recorded.events[0], date }] };
}

function dateWarnings(text: string): string[] {
  return text.split("\n").filter((l) => /^! date /.test(l));
}

const YEAR_AGO = "! date 2022-09-26 is more than a year ago: check it";

describe("date sanity warning", () => {
  it("a photo read with a date years ago warns, keeps Confirm, and comes back with /pending", async () => {
    gemini.extract = lunchOn("2022-09-26");
    await chat.photo();
    const card = chat.last();
    expect(dateWarnings(card.text)).toEqual([YEAR_AGO]);
    expect(card.text).toContain("Confirm to save");
    expect(labels(card)).toEqual(REVIEW);

    const before = chat.replies().length;
    await chat.text("/pending");
    const resent = chat.replies().slice(before);
    expect(resent).toHaveLength(1);
    expect(dateWarnings(resent[0].text)).toEqual([YEAR_AGO]);
    expect(labels(resent[0])).toEqual(REVIEW);
  });

  it("a date in the future warns, and tomorrow does not", async () => {
    const later = daysFromToday(30);
    gemini.extract = lunchOn(later);
    await chat.text("14 lunch at Sandwich Shop");
    expect(dateWarnings(chat.last().text)).toEqual([`! date ${later} is in the future: check it`]);
    expect(labels(chat.last())).toEqual(REVIEW);

    gemini.extract = lunchOn(daysFromToday(1));
    await chat.text("14 lunch at Sandwich Shop tomorrow");
    expect(dateWarnings(chat.last().text)).toEqual([]);
  });

  it("a backfilled date from 4 months ago does not warn", async () => {
    await ledger.add({ date: daysFromToday(-200), amount: "9.99", description: "Older entry" });
    gemini.extract = lunchOn(daysFromToday(-120));
    await chat.text("14 lunch at Sandwich Shop back then");
    expect(dateWarnings(chat.last().text)).toEqual([]);
    expect(labels(chat.last())).toEqual(REVIEW);
  });

  it("a date well before the oldest saved entry warns, and one near it does not", async () => {
    const oldest = daysFromToday(-120);
    await ledger.add({ date: oldest, amount: "9.99", description: "Oldest entry" });
    const early = daysFromToday(-200);
    gemini.extract = lunchOn(early);
    await chat.text("14 lunch at Sandwich Shop long ago");
    expect(dateWarnings(chat.last().text)).toEqual([
      `! date ${early} is before your oldest saved entry (${oldest}): check it`,
    ]);

    gemini.extract = lunchOn(daysFromToday(-140));
    await chat.text("14 lunch at Sandwich Shop a bit earlier");
    expect(dateWarnings(chat.last().text)).toEqual([]);
  });

  it("Fix date to a plausible date clears the warning, and Edit to a bad date brings it back", async () => {
    gemini.extract = lunchOn("2022-09-26");
    await chat.text("14 lunch at Sandwich Shop");
    expect(dateWarnings(chat.last().text)).toEqual([YEAR_AGO]);

    const good = daysFromToday(-3);
    await chat.tap(chat.last(), "Fix date");
    await chat.text(good);
    expect(dateWarnings(chat.last().text)).toEqual([]);
    expect(chat.last().text.split("\n")[0]).toContain(good);
    expect(labels(chat.last())).toEqual(REVIEW);

    const [event] = lunchOn(good).events;
    await chat.tap(chat.last(), "Edit");
    gemini.patch = { ...event, date: "2022-09-26" };
    await chat.text("no, the date is 2022-09-26");
    expect(dateWarnings(chat.last().text)).toEqual([YEAR_AGO]);
  });

  it("a card with no date asks for one and warns about none", async () => {
    gemini.extract = lunchOn(null);
    await chat.photo();
    expect(dateWarnings(chat.last().text)).toEqual([]);
    expect(labels(chat.last())).toEqual(["Discard", "Fix date", "Edit"]);
  });
});
