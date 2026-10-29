import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

type Line = { description: string; tags: string[] };
type Event = { tags: string[]; items: Line[] };

const CAPTION = "road trip snacks; the bananas were for Partner";
const receipt = () => (golden("receipt-line-tag").recorded as { events: Event[] }).events[0];

/** The receipt event with each line's own tags replaced. */
function withLineTags(event: Event, tags: Record<string, string[]>): Event {
  return { ...event, items: event.items.map((l) => ({ ...l, tags: tags[l.description] ?? [] })) };
}

describe("tags for one line or the whole message", () => {
  it("a receipt caption that tags one item saves that tag on that line only", async () => {
    gemini.extract = golden("receipt-line-tag").recorded;
    await chat.photo(CAPTION);

    const card = chat.last().text.split("\n");
    expect(card).toContain("Tags: Travel");
    const bananas = card.indexOf("• Bananas — 6.49");
    expect(card.slice(bananas + 1, bananas + 4)).toContain("  Tags: Partner");
    expect(card.filter((l) => l.trim().startsWith("Tags:"))).toEqual(["Tags: Travel", "  Tags: Partner"]);

    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.lineTags()).toEqual([
      { description: "Bananas", own: ["Partner"], effective: ["Partner", "Travel"] },
      { description: "Rotisserie chicken", own: [], effective: ["Travel"] },
      { description: "Sparkling water", own: [], effective: ["Travel"] },
    ]);
    expect(await ledger.transactionTags()).toEqual([{ type: "expense", tags: ["Travel"] }]);
  });

  it("whole-message context tags every line, stored once on the transaction", async () => {
    // A model that copies the trip onto each line: the tag still lands once, on the header.
    const everyLine = withLineTags({ ...receipt(), tags: [] }, {
      "Rotisserie chicken": ["Travel"],
      Bananas: ["Travel"],
      "Sparkling water": ["Travel"],
    });
    gemini.extract = { events: [everyLine] };
    await chat.photo("road trip snacks");

    const card = chat.last().text.split("\n");
    expect(card.filter((l) => l.trim().startsWith("Tags:"))).toEqual(["Tags: Travel"]);
    await chat.tap(chat.last(), "Confirm");
    expect((await ledger.lineTags()).map((l) => [l.own, l.effective])).toEqual([
      [[], ["Travel"]],
      [[], ["Travel"]],
      [[], ["Travel"]],
    ]);
    expect(await ledger.transactionTags()).toEqual([{ type: "expense", tags: ["Travel"] }]);
  });

  it("a line tag missing from the Tags list is dropped with a warning, and the card still confirms", async () => {
    gemini.extract = { events: [withLineTags(receipt(), { Bananas: ["Neighbour"] })] };
    await chat.photo("road trip snacks; the bananas were for the neighbour");

    const card = chat.last().text;
    expect(card).toContain('! tag "Neighbour" is not in lookup; "Bananas" will save without it');
    expect(card.split("\n").filter((l) => l.trim().startsWith("Tags:"))).toEqual(["Tags: Travel"]);
    expect(labels(chat.last())).toContain("Confirm");

    await chat.tap(chat.last(), "Confirm");
    expect((await ledger.lineTags()).map((l) => [l.description, l.own])).toEqual([
      ["Bananas", []],
      ["Rotisserie chicken", []],
      ["Sparkling water", []],
    ]);
    expect(await ledger.transactionTags()).toEqual([{ type: "expense", tags: ["Travel"] }]);
  });

  it("income and transfer tags stay on the transaction, with no lines to tag", async () => {
    const [transfer] = (golden("transfer").recorded as { events: object[] }).events;
    gemini.extract = { events: [{ ...transfer, tags: ["Travel"] }] };
    await chat.text("moved 50 to my emergency fund on Oct 26 for the trip");
    expect(chat.last().text).toContain("Tags: Travel");
    await chat.tap(chat.last(), "Confirm");

    expect(await ledger.transactionTags()).toEqual([{ type: "transfer", tags: ["Travel"] }]);
    expect(await ledger.lineTags()).toEqual([]);
  });

  it("an Edit can move a line tag to another line, and the card and the save follow it", async () => {
    gemini.extract = golden("receipt-line-tag").recorded;
    await chat.photo(CAPTION);
    await chat.tap(chat.last(), "Edit");
    gemini.patch = withLineTags(receipt(), { "Sparkling water": ["Partner"] });
    await chat.text("the sparkling water was for Partner, not the bananas");

    const card = chat.last().text.split("\n");
    const water = card.indexOf("• Sparkling water — 6.99");
    expect(card.slice(water + 1, water + 4)).toContain("  Tags: Partner");
    expect(card.filter((l) => l.trim().startsWith("Tags:"))).toEqual(["Tags: Travel", "  Tags: Partner"]);

    await chat.tap(chat.last(), "Confirm");
    expect((await ledger.lineTags()).map((l) => [l.description, l.own])).toEqual([
      ["Bananas", []],
      ["Rotisserie chicken", []],
      ["Sparkling water", ["Partner"]],
    ]);
  });
});
