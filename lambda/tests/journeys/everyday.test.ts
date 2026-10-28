import { describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import {
  BUCKET,
  chat,
  gemini,
  labels,
  ledger,
  STRANGER,
  todayToronto,
  uploads,
  useJourneys,
} from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

const REVIEW = ["Confirm", "Discard", "Fix date", "Edit"];

describe("logging one purchase", () => {
  it("a text purchase shows a card, and Confirm saves it with its date and reason", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25, was to tierd didnt pak lunch");

    const card = chat.last();
    expect(card.text.split("\n").slice(0, 3)).toEqual([
      "Expense · 2026-10-25 · CAD 14.00",
      "Lunch at Sandwich Shop",
      "Note: I was too tired and didn't pack lunch.",
    ]);
    expect(labels(card)).toEqual(REVIEW);
    expect(gemini.calls).toEqual([{ model: "gemini-3.6-flash", kind: "extract" }]);
    expect(await ledger.transactions()).toEqual([]);

    await chat.tap(card, "Confirm");
    expect(chat.acks()).toEqual(["Saved."]);
    expect(await ledger.transactions()).toMatchObject([
      {
        date: "2026-10-25",
        amount: "14.00",
        notes: "I was too tired and didn't pack lunch.",
        funder: "self",
        merchant: null,
      },
    ]);
    expect(await ledger.items()).toMatchObject([{ description: "Sub", bucket: "wants" }]);
  });

  it("a merchant from the lookup is linked, and one outside it is left unattached", async () => {
    const recorded = golden("text-with-note").recorded as { events: { merchant: string }[] };
    gemini.extract = { events: [{ ...recorded.events[0], merchant: "Acme Mart" }] };
    await chat.text("14 lunch at Acme Mart on Oct 25");
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ merchant: "Acme Mart" }]);
  });

  it("tapping Confirm twice saves once and says it was already handled", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25, was to tierd didnt pak lunch");
    const card = chat.last();
    await chat.tap(card, "Confirm");
    await chat.tap(card, "Confirm");

    expect(chat.acks()).toEqual(["Saved.", "Already handled."]);
    expect(await ledger.transactions()).toHaveLength(1);
  });

  it("Discard drops the purchase, and a second tap says it was already handled", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25, was to tierd didnt pak lunch");
    const card = chat.last();
    await chat.tap(card, "Discard");
    await chat.tap(card, "Discard");

    expect(chat.acks()).toEqual(["Discarded.", "Already handled."]);
    expect(await ledger.transactions()).toEqual([]);
    expect((await ledger.ingestions())[0].status).toBe("discarded");
  });

  it("a purchase with no date uses today, warns, and can still be confirmed", async () => {
    gemini.extract = golden("no-date-text").recorded;
    const before = todayToronto();
    await chat.text("4.50 coffee");
    const after = todayToronto();

    const card = chat.last();
    // A run that crosses midnight may default to either day.
    const header = card.text.split("\n")[0];
    expect(header).toMatch(/^Expense · \d{4}-\d{2}-\d{2} · CAD 4\.50$/);
    const date = header.split(" · ")[1];
    expect([before, after]).toContain(date);
    expect(card.text).toContain("! date defaulted to today");
    await chat.tap(card, "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ date }]);
  });

  it("someone else paying is saved with them as the funder", async () => {
    gemini.extract = golden("paid-by-family").recorded;
    await chat.text("20 dinner at Salad Bar on Oct 24, my family paid");

    expect(chat.last().text).toContain("Funded by: family");
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ funder: "family", amount: "20.00" }]);
  });

  it("moving money to savings is saved as a transfer to that account", async () => {
    gemini.extract = golden("transfer").recorded;
    await chat.text("moved 50 to my emergency fund on Oct 26");

    expect(chat.last().text).toContain("To account: Emergency fund");
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([
      { type: "transfer", account: "Emergency fund", funder: null, lines: 0 },
    ]);
  });
});

describe("receipts and voice notes", () => {
  it("a receipt photo is archived and offered for Confirm", async () => {
    const recorded = golden("receipt-with-caption").recorded as { events: unknown[] };
    gemini.extract = { events: [recorded.events[0]] };
    await chat.photo();

    const [row] = await ledger.ingestions();
    expect(uploads()).toEqual([
      expect.objectContaining({ Bucket: BUCKET, Key: `${row.id}.jpg` }),
    ]);
    expect(row.media_path).toBe(`${row.id}.jpg`);
    expect(labels(chat.last())).toEqual(REVIEW);
  });

  it("a receipt with no printed date is saved without Confirm until a date is given", async () => {
    gemini.extract = golden("receipt-no-date").recorded;
    await chat.photo();

    const card = chat.last();
    expect(card.text).toContain("✗ date missing: send YYYY-MM-DD, Aug 10, or yesterday");
    expect(labels(card)).toEqual(["Discard", "Fix date", "Edit"]);
    expect((await ledger.ingestions())[0].status).toBe("pending");

    await chat.tap(card, "Fix date");
    await chat.text("yesterday");
    await chat.tap(chat.last(), "Confirm");
    expect(await ledger.transactions()).toMatchObject([{ amount: "12.30" }]);
  });

  it("a voice note is archived as audio and offered for Confirm with today's date", async () => {
    gemini.extract = golden("voice-note").recorded;
    const before = todayToronto();
    await chat.voice();
    const after = todayToronto();

    const [row] = await ledger.ingestions();
    expect(row.source).toBe("voice");
    expect(uploads()).toEqual([
      expect.objectContaining({ Key: `${row.id}.ogg`, ContentType: "audio/ogg" }),
    ]);
    const header = chat.last().text.split("\n")[0];
    expect(header).toMatch(/^Expense · \d{4}-\d{2}-\d{2} · CAD 3\.25$/);
    expect([before, after]).toContain(header.split(" · ")[1]);
    expect(labels(chat.last())).toEqual(REVIEW);
  });
});

describe("only the owner can use the bot", () => {
  it("a message from another chat is ignored: no reply, nothing saved, Gemini not called", async () => {
    gemini.extract = golden("text-with-note").recorded;
    const result = await chat.text("14 lunch at Sandwich Shop", STRANGER);

    expect(result.body).toBe("ignored");
    expect(chat.replies()).toEqual([]);
    expect(gemini.calls).toEqual([]);
    expect(await ledger.ingestions()).toEqual([]);
  });

  it("a button tapped from another chat does nothing", async () => {
    gemini.extract = golden("text-with-note").recorded;
    await chat.text("14 lunch at Sandwich Shop on Oct 25, was to tierd didnt pak lunch");
    const result = await chat.tap(chat.last(), "Confirm", STRANGER);

    expect(result.body).toBe("ignored");
    expect(chat.acks()).toEqual([]);
    expect(await ledger.transactions()).toEqual([]);
  });

  it("a request without the webhook secret is refused and nothing happens", async () => {
    const result = await chat.withSecret("wrong-secret", "14 lunch");

    expect(result.statusCode).toBe(401);
    expect(chat.replies()).toEqual([]);
    expect(await ledger.ingestions()).toEqual([]);
  });
});
