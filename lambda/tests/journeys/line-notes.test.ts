import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
});

useJourneys();

type Line = { description: string; note: string | null };
type Event = { notes: string | null; items: Line[] };

const CAPTION = "road trip snacks, we left before sunrise; the bananas were for Partner, she skipped breakfast";
const receipt = () => (golden("receipt-line-tag").recorded as { events: Event[] }).events[0];

/** The receipt event with its header note and each line's own note replaced. */
function withNotes(notes: string | null, lines: Record<string, string>): Event {
  const event = receipt();
  return { ...event, notes, items: event.items.map((l) => ({ ...l, note: lines[l.description] ?? null })) };
}

const noteLines = (card: string) => card.split("\n").filter((l) => l.trim().startsWith("Note:"));

describe("a note about one line or the whole purchase", () => {
  it("a receipt caption with a reason about one item saves it on that line only, and the purchase's reason on the transaction", async () => {
    gemini.extract = golden("receipt-line-tag").recorded;
    await chat.photo(CAPTION);

    const card = chat.last().text.split("\n");
    expect(card[2]).toBe("Note: we left before sunrise");
    const bananas = card.indexOf("• Bananas — 1.95");
    expect(card.slice(bananas + 1, bananas + 5)).toContain("  Note: she skipped breakfast");
    expect(noteLines(chat.last().text)).toEqual(["Note: we left before sunrise", "  Note: she skipped breakfast"]);

    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.lineNotes()).toEqual([
      { description: "Bananas", note: "she skipped breakfast" },
      { description: "Sparkling Water", note: null },
      { description: "Trail Mix", note: null },
    ]);
    expect((await ledger.transactions()).map((t) => t.notes)).toEqual(["we left before sunrise"]);
  });

  it("a reason the model copies onto every line is saved once, on the transaction", async () => {
    const copied = withNotes(null, {
      "Trail Mix": "we left before sunrise",
      Bananas: "we left before sunrise",
      "Sparkling Water": "we left before sunrise",
    });
    gemini.extract = { events: [copied] };
    await chat.photo("road trip snacks, we left before sunrise");

    expect(noteLines(chat.last().text)).toEqual(["Note: we left before sunrise"]);
    await chat.tap(chat.last(), "Confirm");
    expect((await ledger.lineNotes()).map((l) => l.note)).toEqual([null, null, null]);
    expect((await ledger.transactions()).map((t) => t.notes)).toEqual(["we left before sunrise"]);
  });

  it("a transfer's note stays on the transaction, with no lines to note", async () => {
    const [transfer] = (golden("transfer-withdrawal").recorded as { events: object[] }).events;
    gemini.extract = { events: [{ ...transfer, notes: "saving for the trip" }] };
    await chat.text("moved 50 to my emergency fund on Oct 26, saving for the trip");
    expect(noteLines(chat.last().text)).toEqual(["Note: saving for the trip"]);
    await chat.tap(chat.last(), "Confirm");

    expect((await ledger.transactions()).map((t) => t.notes)).toEqual(["saving for the trip"]);
    expect(await ledger.lineNotes()).toEqual([]);
  });

  it("an Edit can move a line's note to the whole purchase, and the card and the save follow it", async () => {
    gemini.extract = golden("receipt-line-tag").recorded;
    await chat.photo(CAPTION);
    await chat.tap(chat.last(), "Edit");
    gemini.patch = withNotes("we left before sunrise and she skipped breakfast", {});
    await chat.text("skipping breakfast was about the whole trip, not the bananas");

    const sent = JSON.parse(gemini.lastUserText[0]) as { items: Line[] };
    expect(sent.items.map((i) => i.note)).toEqual([null, "she skipped breakfast", null]);
    expect(noteLines(chat.last().text)).toEqual(["Note: we left before sunrise and she skipped breakfast"]);

    await chat.tap(chat.last(), "Confirm");
    expect((await ledger.lineNotes()).map((l) => l.note)).toEqual([null, null, null]);
    expect((await ledger.transactions()).map((t) => t.notes)).toEqual([
      "we left before sunrise and she skipped breakfast",
    ]);
  });

  it("an Edit can move the purchase's note onto one line", async () => {
    gemini.extract = { events: [withNotes("she skipped breakfast", {})] };
    await chat.photo("road trip snacks, she skipped breakfast");
    await chat.tap(chat.last(), "Edit");
    gemini.patch = withNotes(null, { Bananas: "she skipped breakfast" });
    await chat.text("skipping breakfast was only about the bananas");

    const card = chat.last().text.split("\n");
    const bananas = card.indexOf("• Bananas — 1.95");
    expect(card.slice(bananas + 1, bananas + 5)).toContain("  Note: she skipped breakfast");
    expect(noteLines(chat.last().text)).toEqual(["  Note: she skipped breakfast"]);

    await chat.tap(chat.last(), "Confirm");
    expect((await ledger.lineNotes()).find((l) => l.description === "Bananas")?.note).toBe("she skipped breakfast");
    expect((await ledger.transactions()).map((t) => t.notes)).toEqual([null]);
  });

  it("/pending resends a card saved before line notes, and it confirms with none on its lines", async () => {
    gemini.extract = golden("receipt-line-tag").recorded;
    await chat.photo(CAPTION);
    await sql(
      `update ingestions set extraction = jsonb_set(extraction, '{items}',
         (select coalesce(jsonb_agg(i - 'note'), '[]') from jsonb_array_elements(extraction->'items') i))
       where status = 'pending'`,
    );

    await chat.text("/pending");
    expect(noteLines(chat.last().text)).toEqual(["Note: we left before sunrise"]);
    await chat.tap(chat.last(), "Confirm");
    expect((await ledger.lineNotes()).map((l) => l.note)).toEqual([null, null, null]);
  });
});
