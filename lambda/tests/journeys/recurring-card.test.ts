import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { golden } from "../golden/golden.js";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, labels, ledger, STRANGER, useJourneys, type Reply } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

// Saturday 2026-10-31 in Toronto. Only Date is faked; timers stay real.
const NOW = new Date("2026-10-31T16:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
beforeEach(() => {
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

const REVIEW = ["Confirm", "Discard", "Fix date", "Edit"];

/** The owner's monthly internet bill, tracked with four payments. */
async function internetBill(): Promise<number> {
  const bill = (date: string) => ({ date, amount: "64.99", description: "Internet bill", subcategory: "Internet and phone" });
  return ledger.track(
    "Internet bill",
    "monthly",
    await ledger.add(bill("2026-06-15"), bill("2026-07-14"), bill("2026-08-17"), bill("2026-09-15")),
  );
}

/** Gemini's reading of "internet bill <amount>", a one-line bill it calls recurring. */
function billEvent(amount = "64.99", description = "Internet bill") {
  return {
    events: [
      {
        type: "expense",
        amount,
        currency: "CAD",
        date: "2026-10-15",
        description,
        merchant: null,
        venue: null,
        tags: [],
        funded_by: null,
        is_recurring: true,
        income_source: null,
        to_account: null,
        notes: null,
        items: [{ description, amount, category: "Bills", subcategory: "Internet and phone", item_type: null }],
        confidence: 0.9,
      },
    ],
  };
}

async function card(extract: unknown, text = "internet bill 64.99 on Oct 15"): Promise<Reply> {
  gemini.extract = extract;
  await chat.text(text);
  return chat.last();
}

function recurringLines(text: string): string[] {
  return text.split("\n").filter((l) => l.includes("Recurring:") || l.startsWith("↻"));
}

describe("the card proposes the series a payment matches", () => {
  it("a payment matching a series is linked on Confirm", async () => {
    await internetBill();
    const shown = await card(billEvent());
    expect(recurringLines(shown.text)).toEqual(["Funded by: self · Recurring: Internet bill"]);
    expect(labels(shown)).toEqual([...REVIEW, "↻ Internet bill ✓"]);

    await chat.tap(shown, "Confirm");
    expect(chat.acks()).toEqual(["Saved."]);
    expect((await ledger.links())["Internet bill 2026-10-15"]).toEqual({ series: "Internet bill", flagged: true });
  });

  it("toggling the series off saves it unlinked and it is not offered again", async () => {
    await internetBill();
    const shown = await card(billEvent());
    await chat.tap(shown, "↻ Internet bill ✓");
    expect(labels(chat.current(shown))).toEqual([...REVIEW, "↻ not Internet bill"]);
    await chat.tap(shown, "↻ not Internet bill");
    expect(labels(chat.current(shown))).toEqual([...REVIEW, "↻ Internet bill ✓"]);
    await chat.tap(shown, "↻ Internet bill ✓");
    // A toggle only edits the keyboard: only the four tracked bills are saved.
    expect(await ledger.transactions()).toHaveLength(4);
    expect(await sql("SELECT 1 FROM recurring_exclusions")).toEqual([]);

    await chat.tap(shown, "Confirm");
    expect(chat.acks().at(-1)).toBe("Saved.");
    expect((await ledger.links())["Internet bill 2026-10-15"]).toEqual({ series: null, flagged: false });
    await chat.text("/recurring");
    expect(chat.last().text).not.toContain("to review");
  });

  it("an amount outside the usual band adds a note and keeps Confirm", async () => {
    await internetBill();
    const shown = await card(billEvent("80.00"), "internet bill 80 on Oct 15");
    expect(recurringLines(shown.text)).toEqual([
      "Funded by: self · Recurring: Internet bill",
      "↻ Internet bill · usually 64.99; this is 80.00 (+15.01)",
    ]);
    expect(labels(shown)).toEqual([...REVIEW, "↻ Internet bill ✓"]);
    await chat.tap(shown, "Confirm");
    expect((await ledger.links())["Internet bill 2026-10-15"]).toEqual({ series: "Internet bill", flagged: true });
  });

  it("a payment matching no series proposes none and is saved as not recurring", async () => {
    await internetBill();
    const lunch = await card(golden("text-with-note").recorded, "14 lunch at Sandwich Shop on Oct 25");
    expect(recurringLines(lunch.text)).toEqual(["Funded by: self · Recurring: no"]);
    expect(labels(lunch)).toEqual(REVIEW);

    // Gemini calls it recurring, but no series is like it.
    const gym = await card(
      { events: [{ ...billEvent("25.00", "Gym membership").events[0], items: [
        { description: "Gym membership", amount: "25.00", category: "Health and wellness", subcategory: "Fitness", item_type: null },
      ] }] },
      "gym 25 on Oct 15",
    );
    expect(recurringLines(gym.text)).toEqual(["Funded by: self · Recurring: not tracked yet"]);
    expect(labels(gym)).toEqual(REVIEW);
    await chat.tap(gym, "Confirm");
    expect((await ledger.links())["Gym membership 2026-10-15"]).toEqual({ series: null, flagged: false });
  });

  it("an income card names the income series it matches and Confirm links it", async () => {
    const fridays = ["2026-09-11", "2026-09-25", "2026-10-09"];
    await ledger.track(
      "Salary",
      "biweekly",
      await ledger.add(...fridays.map((date) => ({ date, type: "income" as const, amount: "2000.00", description: "Pay", source: "Salary" }))),
    );
    const [pay] = (golden("expense-and-income").recorded as { events: object[] }).events.slice(1);
    const shown = await card({ events: [{ ...pay, amount: "2000.00", date: "2026-10-23" }] }, "got paid 2000 on Oct 23");
    expect(recurringLines(shown.text)).toEqual(["Recurring: Salary"]);
    expect(labels(shown)).toEqual([...REVIEW, "↻ Salary ✓"]);
    await chat.tap(shown, "Confirm");
    expect((await ledger.links())["Salary 2026-10-23"]).toEqual({ series: "Salary", flagged: true });
  });

  it("a transfer card names the transfer series it matches and Confirm links it", async () => {
    const months = ["2026-07-26", "2026-08-26", "2026-09-26"];
    await ledger.track(
      "Savings",
      "monthly",
      await ledger.add(...months.map((date) => ({ date, type: "transfer" as const, amount: "50.00", description: "Savings", to: "Emergency fund" }))),
    );
    const shown = await card(golden("transfer").recorded, "moved 50 to my emergency fund on Oct 26");
    expect(recurringLines(shown.text)).toEqual(["Recurring: Savings"]);
    await chat.tap(shown, "Confirm");
    expect((await ledger.links())["Transfer to emergency fund 2026-10-26"]).toEqual({ series: "Savings", flagged: true });
  });
});

describe("Track as recurring on the Saved reply", () => {
  it("a payment Gemini calls recurring but no series matches offers Track as recurring, which opens the add flow", async () => {
    const shown = await card(billEvent());
    await chat.tap(shown, "Confirm");
    const saved = chat.last();
    expect(saved.text).toBe("Saved.");
    expect(labels(saved)).toEqual(["↻ Track as recurring"]);

    await chat.tap(saved, "↻ Track as recurring");
    expect(chat.current(saved).text.split("\n")[0]).toBe("➕ New recurring item");
    await chat.tap(saved, "Monthly");
    expect((await ledger.links())["Internet bill 2026-10-15"]).toEqual({ series: "Internet bill", flagged: true });
    expect(gemini.calls).toHaveLength(1);
  });

  it("a linked payment, or one Gemini does not call recurring, gets a plain Saved", async () => {
    await card(golden("text-with-note").recorded, "14 lunch at Sandwich Shop on Oct 25");
    await chat.tap(chat.last(), "Confirm");
    expect(labels(chat.last())).toEqual([]);

    await internetBill();
    await card(billEvent());
    await chat.tap(chat.last(), "Confirm");
    expect(chat.last().text).toBe("Saved.");
    expect(labels(chat.last())).toEqual([]);
  });

  it("a payment excluded from the proposed series can still be tracked as its own", async () => {
    await internetBill();
    const shown = await card(billEvent());
    await chat.tap(shown, "↻ Internet bill ✓");
    await chat.tap(shown, "Confirm");
    expect(labels(chat.last())).toEqual(["↻ Track as recurring"]);
  });
});

describe("Confirm on a card with a series", () => {
  it("a card sent before series confirms with c: and links nothing", async () => {
    const shown = await card(billEvent());
    expect(labels(shown)).toEqual(REVIEW);
    await internetBill();
    await chat.tap(shown, "Confirm");
    expect(chat.acks()).toEqual(["Saved."]);
    expect((await ledger.links())["Internet bill 2026-10-15"]).toEqual({ series: null, flagged: false });
  });

  it("Confirm after the proposed series was deleted saves the payment unlinked and says so", async () => {
    const internet = await internetBill();
    const shown = await card(billEvent());
    await sql("DELETE FROM recurring_series WHERE id = $1", [internet]);
    await chat.tap(shown, "Confirm");
    const ack = "Saved. Not linked: that recurring series is gone or no longer fits.";
    expect(chat.acks()).toEqual([ack]);
    expect(chat.last().text).toBe(ack);
    expect((await ledger.links())["Internet bill 2026-10-15"]).toEqual({ series: null, flagged: false });
  });

  it("a double tap on a card's Confirm saves and links once", async () => {
    await internetBill();
    const shown = await card(billEvent());
    await chat.tap(shown, "Confirm");
    await chat.tap(shown, "Confirm");
    expect(chat.acks()).toEqual(["Saved.", "Already handled."]);
    expect(await ledger.transactions()).toHaveLength(5);
    expect((await ledger.links())["Internet bill 2026-10-15"]).toEqual({ series: "Internet bill", flagged: true });
  });

  it("a card's series toggle tapped from another chat does nothing", async () => {
    await internetBill();
    const shown = await card(billEvent());
    const result = await chat.tap(shown, "↻ Internet bill ✓", STRANGER);
    expect(result.body).toBe("ignored");
    expect(labels(chat.current(shown))).toEqual([...REVIEW, "↻ Internet bill ✓"]);
    expect(chat.acks()).toEqual([]);
  });
});
