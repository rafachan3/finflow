import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { retryWait } from "../../src/gemini.js";
import { golden } from "../golden/golden.js";
import { registerUtilityTopic } from "../../src/db.js";
import { chat, gemini, invokeNudge, labels, ledger, OWNER, takeTelegramRejections, useJourneys, type Reply } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return {
    getConfig: async () => config,
    getDbUrl: async () => config.databaseUrl,
    getNudgeConfig: async () => ({
      botToken: config.botToken,
      allowedChatIds: config.allowedChatIds,
      databaseUrl: config.databaseUrl,
    }),
  };
});

useJourneys();
beforeEach(() => chat.topicMode(true));

// Saturday 2026-10-31, 09:00 in Toronto. Only Date is faked; timers stay real.
const NOW = new Date("2026-10-31T13:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

const ALL_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

/** A gym whose Aug 3 payment was never logged: due, so the digest has something to post. */
async function trackGym(): Promise<number> {
  const days = ["2026-06-03", "2026-07-03", "2026-09-03", "2026-10-02"];
  return ledger.track(
    "Gym",
    "monthly",
    await ledger.add(...days.map((date) => ({ date, amount: "25.00", description: "Gym", subcategory: "Fitness" }))),
  );
}

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
    // A wait from before topics answers a message in any topic, and Telegram
    // always opens a new topic for the created notice, so only that wait shows the filter.
    chat.topicMode(false);
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();
    await chat.tap(cards()[0], "Fix date");
    chat.topicMode(true);
    let sent = chat.replies().length;

    await chat.topicNotice();
    expect(chat.replies()).toHaveLength(sent);
    expect((await ledger.ingestions())[0].status).toBe("awaiting_date");
    await chat.tap(chat.last(), "Keep as is");

    // The renamed notice arrives in the topic whose card waits.
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const card = cards().at(-1)!;
    await chat.tap(card, "Fix date");
    sent = chat.replies().length;

    await chat.topicRenamedNotice(card.thread!, "Lunch");
    expect(chat.replies()).toHaveLength(sent);
    expect((await ledger.ingestions())[1].status).toBe("awaiting_date");
  });
});

describe("replies stay in their topic", () => {
  it("a command's reply comes back in the topic the command opened", async () => {
    await chat.text("/merchants");

    expect(chat.last().thread).toBe(chat.lastTopic());
  });

  it("a message Gemini cannot read gets its failure reply in its own topic", async () => {
    gemini.extract = golden("text-with-note").recorded;
    gemini.overloaded = new Set(ALL_MODELS);
    await chat.text("14 lunch at Sandwich Shop");

    expect(chat.last().text).toContain("Gemini is overloaded right now");
    expect(chat.last().thread).toBe(chat.lastTopic());
  });

  it("/recurring opens its menu in the command's topic, and a rename prompt and its answer stay there", async () => {
    await trackGym();
    await chat.text("/recurring");
    const menu = chat.last();
    expect(menu.thread).toBe(chat.lastTopic());

    await chat.tap(menu, "Gym");
    await chat.tap(menu, "✏️ Rename");
    const prompt = chat.last();
    expect(prompt.text).toMatch(/^Rename #\d+ /);
    expect(prompt.thread).toBe(menu.thread);

    await chat.reply(prompt, "Fitness club");
    expect(chat.last().text).toBe("Renamed to Fitness club.");
    expect(chat.last().thread).toBe(menu.thread);
  });

  it("the daily digest still posts in the main view", async () => {
    await trackGym();
    await invokeNudge(NOW.toISOString());

    const digest = chat.calls("sendMessage").at(-1)!;
    expect(digest.text).toContain("Recurring");
    expect(digest).not.toHaveProperty("message_thread_id");
  });
});

describe("Fix date and Edit inside a purchase topic", () => {
  it("Fix date inside a purchase topic asks there, and the date sent there gives a new card in the same topic", async () => {
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();
    const [card] = cards();

    await chat.tap(card, "Fix date");
    const prompt = chat.last();
    expect(prompt.text).toBe("Send the date as YYYY-MM-DD, Aug 10, or yesterday.");
    expect(prompt.thread).toBe(card.thread);
    const renames = chat.calls("editForumTopic").length;

    await chat.inTopic(card.thread!).text("2026-11-20");
    const fixed = cards().at(-1)!;
    expect(labels(fixed)).toContain("Confirm");
    expect(fixed.thread).toBe(card.thread);
    // A date is not in the topic's name, so the topic keeps it.
    expect(chat.calls("editForumTopic")).toHaveLength(renames);
    const [row] = await ledger.ingestions();
    expect(row.card_message_id).toBe(fixed.messageId);
    expect(row.telegram_thread_id).toBe(card.thread);
  });

  it("an Edit that changes the amount renames the topic", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();

    await chat.tap(card, "Edit");
    expect(chat.last().thread).toBe(card.thread);
    gemini.patch = golden("edit-amount").recorded;
    await chat.inTopic(card.thread!).text("it was 14.50");

    expect(cards().at(-1)!.thread).toBe(card.thread);
    expect(chat.topicName(card.thread!)).toBe("Sandwich Shop · $14.50");
  });

  it("while a card waits for a date, a purchase sent from the main view becomes its own card, not the date", async () => {
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();
    const [cardA] = cards();
    await chat.tap(cardA, "Fix date");

    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");

    const card2 = cards().at(-1)!;
    expect(card2.thread).toBe(chat.lastTopic());
    expect(card2.thread).not.toBe(cardA.thread);
    expect(chat.topicName(card2.thread!)).toBe("Sandwich Shop · $14.00");
    expect((await ledger.ingestions())[0].status).toBe("awaiting_date");
    expect(chat.replies().map((r) => r.text)).not.toContain(
      "Still waiting for a date for the previous item. Send YYYY-MM-DD, Aug 10, or yesterday — or tap Keep as is / Discard.",
    );
  });

  it("Keep as is in a topic resends the card there", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    await chat.tap(card, "Fix date");
    const renames = chat.calls("editForumTopic").length;

    await chat.tap(chat.last(), "Keep as is");

    const kept = cards().at(-1)!;
    expect(labels(kept)).toContain("Confirm");
    expect(kept.thread).toBe(card.thread);
    expect(chat.calls("editForumTopic")).toHaveLength(renames);
  });

  it("while a card whose topic was refused waits for a correction, a purchase from the main view is not that correction", async () => {
    gemini.extract = golden("two-stores").recorded;
    chat.refuseNextTopicCreates(1);
    await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");
    takeTelegramRejections();
    const [, second] = cards();
    await chat.tap(second, "Edit");
    expect(chat.last().thread).toBe(second.thread);

    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");

    expect(cards().at(-1)!.thread).toBe(chat.lastTopic());
    expect(gemini.calls.map((c) => c.kind)).not.toContain("patch");
    expect((await ledger.ingestions())[1].status).toBe("awaiting_edit");
  });

  it("a card from before topics, dated from inside a topic, gets its new card there and keeps that topic", async () => {
    chat.topicMode(false);
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();
    await chat.tap(cards()[0], "Fix date");

    chat.topicMode(true);
    await chat.text("yesterday");

    const fixed = cards().at(-1)!;
    expect(fixed.thread).toBe(chat.lastTopic());
    const [row] = await ledger.ingestions();
    expect(row.telegram_thread_id).toBe(chat.lastTopic());
    expect(row.card_message_id).toBe(fixed.messageId);
  });

  it("a card from before topics, dated inside another purchase's topic, leaves that topic and its name alone", async () => {
    chat.topicMode(false);
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();
    const [old] = cards();

    chat.topicMode(true);
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const other = cards().at(-1)!;
    await chat.tap(old, "Fix date");
    const renames = chat.calls("editForumTopic").length;

    await chat.inTopic(other.thread!).text("yesterday");

    expect(cards().at(-1)!.thread).toBe(other.thread);
    expect(chat.calls("editForumTopic")).toHaveLength(renames);
    expect(chat.topicName(other.thread!)).toBe("Sandwich Shop · $14.00");
    const [oldRow, otherRow] = await ledger.ingestions();
    expect(oldRow.telegram_thread_id).toBeNull();
    expect(otherRow.telegram_thread_id).toBe(other.thread);
  });
});

describe("Confirm inside a purchase topic", () => {
  it("Confirm turns the card's buttons into one ✅ Saved and puts ✅ on the topic, with no Saved message", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    const sent = chat.replies().length;

    await chat.tap(card, "Confirm");

    expect(labels(chat.current(card))).toEqual(["✅ Saved"]);
    expect(chat.current(card).text).toBe(card.text);
    expect(chat.topicName(card.thread!)).toBe("✅ Sandwich Shop · $14.00");
    expect(chat.replies()).toHaveLength(sent);
    expect(chat.acks()).toEqual(["Saved: Sandwich Shop · $14.00."]);
  });

  it("Confirm still saves when the topic rename is refused", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    chat.refuseNextTopicEdits(1);

    await chat.tap(card, "Confirm");
    expect(takeTelegramRejections()).toEqual(["editForumTopic: refused"]);

    expect(await ledger.transactions()).toHaveLength(1);
    expect(labels(chat.current(card))).toEqual(["✅ Saved"]);
    expect(chat.topicName(card.thread!)).toBe("Sandwich Shop · $14.00");
  });

  it("Confirm still marks the card and topic ✅ and answers 200 when Telegram refuses the tap's answer", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    chat.refuseNextAnswers(1);

    const result = await chat.tap(card, "Confirm");

    expect(result.statusCode).toBe(200);
    expect(await ledger.transactions()).toHaveLength(1);
    expect(labels(chat.current(card))).toEqual(["✅ Saved"]);
    expect(chat.topicName(card.thread!)).toBe("✅ Sandwich Shop · $14.00");
  });

  it("a Confirm the database refuses shows a pop-up, saves nothing, keeps the card, and answers 200", async () => {
    const [event] = (golden("text-with-note").recorded as { events: Record<string, unknown>[] }).events;
    // Passes the bot's checks, but overflows numeric(12,2): Postgres refuses it (22003).
    const items = (event.items as Record<string, unknown>[]).map((item) => ({ ...item, amount: "12345678901.00" }));
    gemini.extract = { events: [{ ...event, amount: "12345678901.00", items }] };
    await chat.text("12345678901 lunch at Sandwich Shop");
    const [card] = cards();
    const sent = chat.replies().length;

    const result = await chat.tap(card, "Confirm");

    expect(result.statusCode).toBe(200);
    expect(chat.acks()).toEqual(["Couldn't save this one — tap Edit or Discard."]);
    expect(await ledger.transactions()).toEqual([]);
    expect((await ledger.ingestions())[0].status).toBe("pending");
    expect(labels(chat.current(card))).toEqual(labels(card));
    expect(chat.replies()).toHaveLength(sent);
  });

  it("a payment that looks recurring still gets its Saved reply with the recurring buttons, in its topic", async () => {
    const [event] = (golden("text-with-note").recorded as { events: Record<string, unknown>[] }).events;
    gemini.extract = { events: [{ ...event, is_recurring: true }] };
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();

    await chat.tap(card, "Confirm");

    const saved = chat.last();
    expect(saved.text).toBe("Saved.");
    expect(saved.thread).toBe(card.thread);
    expect(labels(saved)[0]).toMatch(/^↻/);
    expect(labels(chat.current(card))).toEqual(["✅ Saved"]);
  });

  it("an old card from before topics confirms in place and renames no topic", async () => {
    chat.topicMode(false);
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    chat.topicMode(true);

    await chat.tap(card, "Confirm");

    expect(labels(chat.current(card))).toEqual(["✅ Saved"]);
    expect(chat.calls("editForumTopic")).toEqual([]);
    expect(await ledger.transactions()).toHaveLength(1);
  });
});

describe("Discard inside a purchase topic", () => {
  it("Discard deletes the purchase's topic with its card, and the pop-up names the purchase", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    const sent = chat.replies().length;

    await chat.tap(card, "Discard");

    expect(chat.acks()).toEqual(["Discarded: Sandwich Shop · $14.00."]);
    expect(chat.topicExists(card.thread!)).toBe(false);
    expect(chat.exists(card)).toBe(false);
    expect((await ledger.ingestions())[0].status).toBe("discarded");
    expect(chat.replies()).toHaveLength(sent);
  });

  it("if the topic cannot be deleted, Discard renames it 🗑 and clears the card's buttons", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    const sent = chat.replies().length;
    chat.refuseNextTopicDeletes(1);

    await chat.tap(card, "Discard");
    expect(takeTelegramRejections()).toEqual(["deleteForumTopic: refused"]);

    expect(chat.acks()).toEqual(["Discarded: Sandwich Shop · $14.00."]);
    expect(chat.replies()).toHaveLength(sent);

    expect(chat.topicName(card.thread!)).toBe("🗑 Sandwich Shop · $14.00");
    expect(labels(chat.current(card))).toEqual([]);
    expect((await ledger.ingestions())[0].status).toBe("discarded");
  });

  it("Discard still deletes the topic and answers 200 when Telegram refuses the tap's answer", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    chat.refuseNextAnswers(1);

    const result = await chat.tap(card, "Discard");

    expect(result.statusCode).toBe(200);
    expect((await ledger.ingestions())[0].status).toBe("discarded");
    expect(chat.topicExists(card.thread!)).toBe(false);
  });

  it("a stale Confirm on a saved purchase names it", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const [card] = cards();
    const [{ id }] = await ledger.ingestions();
    await chat.tap(card, "Confirm");

    await chat.press(card, `c:${id}`);

    expect(chat.acks()).toEqual(["Saved: Sandwich Shop · $14.00.", "Already handled: Sandwich Shop · $14.00 was saved."]);
    expect(await ledger.transactions()).toHaveLength(1);
  });

  it("discarding a card that shares another purchase's topic leaves that topic and its card", async () => {
    gemini.extract = golden("two-stores").recorded;
    chat.refuseNextTopicCreates(1);
    await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");
    takeTelegramRejections();
    const [first, second] = cards();

    await chat.tap(second, "Discard");

    expect(chat.acks()).toEqual(["Discarded: Acme Mart Pharmacy · $5.00."]);
    expect(chat.calls("deleteForumTopic")).toEqual([]);
    expect(chat.topicName(chat.lastTopic())).toBe("Dollar Corner · $3.00");
    expect(chat.exists(first)).toBe(true);
    expect(labels(chat.current(first))).toEqual(labels(first));
    expect(chat.last().text).toBe("Discarded: Acme Mart Pharmacy · $5.00.");
    expect(chat.last().thread).toBe(chat.lastTopic());
  });

  it("discarding a purchase whose topic holds another purchase's card hands the topic to that purchase", async () => {
    gemini.extract = golden("two-stores").recorded;
    chat.refuseNextTopicCreates(1);
    await chat.text("3 at Dollar Corner and 5 at Acme Mart Pharmacy");
    takeTelegramRejections();
    const topic = chat.lastTopic();
    const [first, second] = cards();
    await chat.tap(second, "Fix date");

    await chat.tap(first, "Discard");

    expect(chat.acks()).toEqual(["Send the date.", "Discarded: Dollar Corner · $3.00."]);
    expect(chat.calls("deleteForumTopic")).toEqual([]);
    expect(chat.topicName(topic)).toBe("Acme Mart Pharmacy · $5.00");
    expect(labels(chat.current(first))).toEqual([]);
    expect((await ledger.ingestions())[1].telegram_thread_id).toBe(topic);

    // The wait still listens in that topic: a date sent there lands on the second purchase.
    await chat.inTopic(topic).text("2026-10-30");
    const fixed = cards().at(-1)!;
    expect(labels(fixed)).toContain("Confirm");
    expect(fixed.thread).toBe(topic);
    const [, row] = await ledger.ingestions();
    expect(row.status).toBe("pending");
    expect(row.card_message_id).toBe(fixed.messageId);
  });
});

describe("command and no-purchase topics are deleted when done", () => {
  it("a command's topic is deleted by the first message the owner sends an hour or more later", async () => {
    await chat.text("/merchants");
    const topic = chat.lastTopic();
    await ledger.ageUtilityTopics(3600);

    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");

    expect(chat.topicExists(topic)).toBe(false);
    expect(chat.topicExists(cards().at(-1)!.thread!)).toBe(true);
  });

  it("the tidy-up never deletes a purchase's topic, even if a note was left on it", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop");
    const card = cards().at(-1)!;
    // A Telegram retry can note the topic just after the purchase took it over.
    await registerUtilityTopic(OWNER, card.thread!, "No purchase");
    await ledger.ageUtilityTopics(3600);

    await chat.text("/merchants");

    expect(chat.topicExists(card.thread!)).toBe(true);
  });

  it("a command's topic younger than an hour stays", async () => {
    await chat.text("/merchants");
    const topic = chat.lastTopic();
    await ledger.ageUtilityTopics(3500);

    await chat.text("/merchants");

    expect(chat.topicExists(topic)).toBe(true);
  });

  it("a command topic used again within the hour stays an hour after its last message", async () => {
    await chat.text("/merchants");
    const topic = chat.lastTopic();
    await ledger.ageUtilityTopics(3000);
    await chat.inTopic(topic).text("/merchants");
    await ledger.ageUtilityTopics(3000);

    await chat.text("/merchants");
    expect(chat.topicExists(topic)).toBe(true);

    await ledger.ageUtilityTopics(700);
    await chat.text("/merchants");
    expect(chat.topicExists(topic)).toBe(false);
  });

  it("a no-purchase message's topic is deleted later like a command's", async () => {
    gemini.extract = golden("text-with-note").recorded;
    gemini.overloaded = new Set(ALL_MODELS);
    await chat.text("14 lunch at Sandwich Shop");
    const topic = chat.lastTopic();
    expect(await ledger.utilityTopics()).toEqual([{ thread_id: topic, label: "No purchase" }]);
    await ledger.ageUtilityTopics(3600);

    await chat.text("/merchants");

    expect(chat.topicExists(topic)).toBe(false);
  });

  it("Close on a /recurring menu in its topic deletes the topic", async () => {
    await trackGym();
    await chat.text("/recurring");
    const menu = chat.last();

    await chat.tap(menu, "✕ Close");

    expect(chat.topicExists(menu.thread!)).toBe(false);
    expect(await ledger.utilityTopics()).toEqual([]);
  });

  it("a message in an hour-old command topic keeps it from a tidy-up running at the same time", async () => {
    await chat.text("/merchants");
    const topic = chat.lastTopic();
    await ledger.ageUtilityTopics(3600);

    // Hold the message at Gemini's first retry while another message's tidy-up runs.
    gemini.extract = golden("text-with-note").recorded;
    gemini.overloaded = new Set(ALL_MODELS);
    let atRetry!: () => void;
    const reachedRetry = new Promise<void>((resolve) => (atRetry = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    retryWait.sleep = async () => {
      atRetry();
      await held;
    };
    const slow = chat.inTopic(topic).text("14 lunch at Sandwich Shop");
    await reachedRetry;
    await chat.text("/merchants");
    release();
    await slow;

    expect(chat.topicExists(topic)).toBe(true);
    expect(chat.last().text).toContain("Gemini is overloaded right now");
    expect(chat.last().thread).toBe(topic);
  });

  it("Close on a /recurring menu whose topic cannot be deleted renames it ⚙️ and closes the menu", async () => {
    await trackGym();
    await chat.text("/recurring");
    const menu = chat.last();
    chat.refuseNextTopicDeletes(1);

    await chat.tap(menu, "✕ Close");

    expect(takeTelegramRejections()).toEqual(["deleteForumTopic: refused"]);
    expect(chat.topicName(menu.thread!)).toBe("⚙️ /recurring");
    expect(chat.exists(menu)).toBe(false);
    expect(await ledger.utilityTopics()).toEqual([]);
  });

  it("if a topic cannot be tidied away it is renamed ⚙️ and not tried again", async () => {
    await chat.text("/merchants");
    const topic = chat.lastTopic();
    await ledger.ageUtilityTopics(3600);
    chat.refuseNextTopicDeletes(1);

    await chat.text("/merchants");
    expect(takeTelegramRejections()).toEqual(["deleteForumTopic: refused"]);
    expect(chat.topicName(topic)).toBe("⚙️ /merchants");

    await ledger.ageUtilityTopics(3600);
    await chat.text("/merchants");
    expect(chat.topicExists(topic)).toBe(true);
    expect(chat.calls("deleteForumTopic").filter((c) => c.message_thread_id === topic)).toEqual([]);
  });

  it("a purchase sent in a command's topic keeps that topic, which is then never tidied away", async () => {
    await chat.text("/merchants");
    const topic = chat.lastTopic();

    gemini.extract = golden("text-with-note").recorded;
    await chat.inTopic(topic).text("14 lunch at Sandwich Shop");
    expect(cards().at(-1)!.thread).toBe(topic);
    expect(chat.topicName(topic)).toBe("Sandwich Shop · $14.00");

    await ledger.ageUtilityTopics(3600);
    await chat.text("/merchants");
    expect(chat.topicExists(topic)).toBe(true);
  });

  it("a purchase's topic is never tidied away", async () => {
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();
    const [card] = cards();
    await chat.tap(card, "Fix date");
    await chat.inTopic(card.thread!).text("2026-10-30");

    await ledger.ageUtilityTopics(3600);
    await chat.text("/merchants");
    expect(chat.topicExists(card.thread!)).toBe(true);
  });

  it("a card from before topics, dated inside a topic, keeps that topic after the tidy-up", async () => {
    chat.topicMode(false);
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();
    await chat.tap(cards()[0], "Fix date");

    chat.topicMode(true);
    await chat.text("/merchants");
    const topic = chat.lastTopic();
    await chat.inTopic(topic).text("yesterday");
    expect(cards().at(-1)!.thread).toBe(topic);

    await ledger.ageUtilityTopics(3600);
    await chat.text("/merchants");
    expect(chat.topicExists(topic)).toBe(true);
  });
});
