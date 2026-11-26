import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, labels, ledger, takeTelegramRejections, useJourneys } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
});

useJourneys();

const header = (text: string) => text.split("\n")[0];

async function twoCards() {
  gemini.extract = golden("two-stores").recorded;
  await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");
  return chat.replies();
}

/** The replies one message produced. */
async function send(text: string) {
  const before = chat.replies().length;
  await chat.text(text);
  return chat.replies().slice(before);
}

describe("/pending", () => {
  it("/pending lists a link to each open purchase's topic, oldest first, and resends no card", async () => {
    chat.topicMode(true);
    const cards = await twoCards();
    const t1 = chat.lastTopic();
    const t2 = cards[cards.length - 1].thread!;
    const created = chat.calls("createForumTopic").length;

    const resent = await send("/pending");
    expect(resent).toHaveLength(1);
    expect(resent[0].html).toBe(
      [
        "Open purchases:",
        `• <a href="https://t.me/journey_bot/${t1}">Dollar Corner · $3.00</a>`,
        `• <a href="https://t.me/journey_bot/${t2}">Acme Mart Pharmacy · $5.00</a>`,
      ].join("\n"),
    );
    expect(resent[0].thread).toBe(chat.lastTopic());
    expect(chat.calls("createForumTopic")).toHaveLength(created);
    expect(gemini.calls).toHaveLength(1);
  });

  it("a card that never arrived comes back with /pending and can be confirmed", async () => {
    chat.topicMode(true);
    chat.failNextSends(1);
    expect((await twoCards()).filter((r) => r.buttons.length > 0)).toHaveLength(1);
    const t1 = chat.lastTopic();

    const resent = await send("/pending");
    expect(resent.map((r) => header(r.text))).toEqual([expect.stringMatching(/ · CAD 3\.00$/), "Open purchases:"]);
    expect(resent[0].thread).toBe(t1);
    expect(labels(resent[0])).toEqual(["Confirm", "Discard", "Fix date", "Edit"]);
    expect(resent[1].text).toContain("Dollar Corner · $3.00");
    expect(gemini.calls).toHaveLength(1);

    await chat.tap(resent[0], "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "3.00" }]);
    expect(chat.acks()).toEqual(["Saved: Dollar Corner · $3.00."]);
    const again = await send("/pending");
    expect(again.map((r) => r.text)).toEqual(["Open purchases:\n• Acme Mart Pharmacy · $5.00"]);
  });

  it("/pending moves an open card from before topics into a new topic and links it", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25");
    const old = chat.last();
    chat.topicMode(true);

    const [card, list] = await send("/pending");
    expect(card.thread).toBeDefined();
    expect(chat.topicName(card.thread!)).toBe("Sandwich Shop · $14.00");
    expect(labels(card)).toEqual(["Confirm", "Discard", "Fix date", "Edit"]);
    expect(labels(chat.current(old))).toEqual([]);
    expect(list.html).toBe(`Open purchases:\n• <a href="https://t.me/journey_bot/${card.thread}">Sandwich Shop · $14.00</a>`);
    expect((await ledger.ingestions()).map((r) => r.telegram_thread_id)).toEqual([card.thread]);

    await chat.tap(card, "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "14.00" }]);
  });

  it("/pending sends a card to the main view when its topic is refused, and still links the next", async () => {
    await twoCards();
    chat.topicMode(true);
    chat.refuseNextTopicCreates(1);

    const [first, second, list] = await send("/pending");
    expect(takeTelegramRejections()).toEqual(["createForumTopic: refused"]);
    expect([first.thread, header(first.text)]).toEqual([undefined, expect.stringMatching(/ · CAD 3\.00$/)]);
    expect(chat.topicName(second.thread!)).toBe("Acme Mart Pharmacy · $5.00");
    expect(list.html).toBe(
      [
        "Open purchases:",
        "• Dollar Corner · $3.00",
        `• <a href="https://t.me/journey_bot/${second.thread}">Acme Mart Pharmacy · $5.00</a>`,
      ].join("\n"),
    );
  });

  it("/pending marks a card waiting for a date", async () => {
    chat.topicMode(true);
    const [first] = await twoCards();
    const t1 = chat.lastTopic();
    await chat.tap(first, "Fix date");

    const resent = await send("/pending");
    expect(resent.map((r) => r.text)).toEqual([
      "Open purchases:\n• Dollar Corner · $3.00 (waiting for a date)\n• Acme Mart Pharmacy · $5.00",
    ]);
    expect((await ledger.ingestions()).map((r) => r.status)).toEqual(["awaiting_date", "pending"]);

    await chat.inTopic(t1).text("2026-10-01");
    expect(header(chat.last().text)).toBe("Expense · 2026-10-01 · CAD 3.00");
    expect(chat.last().thread).toBe(t1);
    expect(gemini.calls).toHaveLength(1);
  });

  it("with nothing pending, /pending says so and asks Gemini nothing", async () => {
    expect((await send("/pending")).map((r) => r.text)).toEqual(["No pending cards."]);
    expect((await send("/pending@any_bot")).map((r) => r.text)).toEqual(["No pending cards."]);
    expect(gemini.calls).toEqual([]);
    expect(await ledger.ingestions()).toEqual([]);
  });
});
