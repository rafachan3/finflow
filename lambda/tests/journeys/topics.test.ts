import { beforeEach, describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { chat, gemini, ledger, takeTelegramRejections, useJourneys, type Reply } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
});

useJourneys();
beforeEach(() => chat.topicMode(true));

const cards = (): Reply[] => chat.replies().filter((r) => r.buttons.length > 0);

describe("each purchase in its own topic", () => {
  it("a purchase sent in the main view gets its card in the topic the message opened, named after the purchase", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");

    const [card] = cards();
    expect(card.thread).toBe(chat.lastTopic());
    expect(chat.topicName(card.thread!)).toBe("Sandwich Shop · $14.00");
    const [row] = await ledger.ingestions();
    expect(row.telegram_thread_id).toBe(card.thread);
    expect(row.card_message_id).toBe(card.messageId);
  });

  it("a purchase with no merchant names its topic after the description", async () => {
    gemini.extract = golden("no-place-lines").recorded;
    await chat.text("16 lunch and coffee");

    const [card] = cards();
    expect(card.thread).toBe(chat.lastTopic());
    expect(chat.topicName(card.thread!)).toBe("Lunch and coffee · $16.00");
  });

  it("two purchases in one message get two topics, the second with a link back to the message", async () => {
    gemini.extract = golden("two-stores").recorded;
    await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");

    const [card1, card2] = cards();
    expect(card1.thread).toBe(chat.lastTopic());
    expect(chat.topicName(card1.thread!)).toBe("Dollar Corner · $3.00");
    expect(card2.thread).not.toBe(card1.thread);
    expect(chat.topicName(card2.thread!)).toBe("Acme Mart Pharmacy · $5.00");
    expect(chat.calls("createForumTopic")).toMatchObject([{ name: "Acme Mart Pharmacy · $5.00" }]);

    const inTopic2 = chat.replies().filter((r) => r.thread === card2.thread);
    const before = inTopic2[inTopic2.findIndex((r) => r.messageId === card2.messageId) - 1];
    expect(before.html).toContain(`https://t.me/journey_bot/${card1.thread}`);

    const rows = await ledger.ingestions();
    expect(rows.map((r) => [r.telegram_thread_id, r.card_message_id])).toEqual([
      [card1.thread, card1.messageId],
      [card2.thread, card2.messageId],
    ]);
  });

  it("a purchase sent inside another purchase's topic gets a new topic", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card1] = cards();

    gemini.extract = golden("receipt-with-tip").recorded;
    await chat.inTopic(card1.thread!).photo();

    const card2 = cards()[1];
    expect(card2.thread).toBeDefined();
    expect(card2.thread).not.toBe(card1.thread);
    expect((await ledger.ingestions())[1].telegram_thread_id).toBe(card2.thread);
  });

  it("if a new topic cannot be created, the extra purchase's card goes to the message's topic", async () => {
    gemini.extract = golden("two-stores").recorded;
    chat.refuseNextTopicCreates(1);
    await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");

    expect(cards().map((c) => c.thread)).toEqual([chat.lastTopic(), chat.lastTopic()]);
    const [, second] = await ledger.ingestions();
    expect(second.telegram_thread_id).toBeNull();
    expect(second.card_message_id).toBe(cards()[1].messageId);
    expect(takeTelegramRejections()).toEqual(["createForumTopic: refused"]);
  });

  it("Telegram resending a purchase in topic mode creates no topic and no card", async () => {
    gemini.extract = golden("two-stores").recorded;
    await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");
    const creates = chat.calls("createForumTopic").length;
    const sends = chat.calls("sendMessage").length;

    await chat.retry();

    expect(chat.calls("createForumTopic")).toHaveLength(creates);
    expect(chat.calls("sendMessage")).toHaveLength(sends);
    expect(await ledger.ingestions()).toHaveLength(2);
  });

  it("Telegram's topic-created and topic-renamed notices get no reply, even while a card waits for a date", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    await chat.tap(card, "Fix date");
    const sent = chat.replies().length;

    await chat.topicNotice();
    expect(chat.replies()).toHaveLength(sent);

    await chat.topicRenamedNotice(card.thread!, "Lunch");
    expect(chat.replies()).toHaveLength(sent);
    expect((await ledger.ingestions())[0].status).toBe("awaiting_date");
  });
});
