import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, labels, ledger, STRANGER, useJourneys, type Reply } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config, getDbUrl: async () => config.databaseUrl };
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

const hosting = (date: string, amount = "0.40", description = "Cloud hosting bill") => ({
  date,
  amount,
  description,
  subcategory: "Internet and phone",
});

/** A small monthly hosting bill, tracked with three payments on the 3rd. */
async function hostingBill(): Promise<number> {
  return ledger.track("Cloud hosting bill", "monthly", await ledger.add(hosting("2026-06-03"), hosting("2026-07-03"), hosting("2026-08-03")));
}

/** Gemini's reading of a one-line expense it calls recurring. */
function event(amount: string, date: string, description: string) {
  return {
    events: [
      {
        type: "expense",
        amount,
        currency: "CAD",
        date,
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

async function card(extract: unknown, text: string): Promise<Reply> {
  gemini.extract = extract;
  await chat.text(text);
  return chat.last();
}

/** /recurring → ➕ Add → that saved payment: the add screen, in the list's message. */
async function addScreenFor(label: string): Promise<Reply> {
  await chat.text("/recurring");
  const menu = chat.last();
  await chat.tap(menu, "➕ Add");
  await chat.tap(menu, label);
  return menu;
}

const recurringLine = (text: string) => text.split("\n").filter((l) => l.includes("Recurring:"));

describe("adding a payment to a series it already belongs to", () => {
  it("a payment worded unlike its series is added from the add screen, and the next one like it is proposed on the card", async () => {
    await hostingBill();
    await ledger.add(hosting("2026-09-03", "0.39", "Nimbus web services"));

    const screen = await addScreenFor("Sep 3 · 0.39 · Nimbus web services");
    expect(chat.current(screen).text.split("\n").slice(0, 3)).toEqual([
      "↻ Add to a series, or start a new one",
      "From Sep 3 · 0.39 · Nimbus web services",
      "↻ Add to: series you track, the closest in timing and amount first.",
    ]);
    expect(labels(chat.current(screen))[0]).toBe("↻ Add to Cloud hosting bill");

    await chat.tap(screen, "↻ Add to Cloud hosting bill");
    expect(chat.acks().at(-1)).toBe("Added to Cloud hosting bill.");
    expect(chat.current(screen).text.split("\n")[0]).toBe("↻ Cloud hosting bill — expense · Bills › Internet and phone");
    expect((await ledger.links())["Nimbus web services 2026-09-03"]).toEqual({ series: "Cloud hosting bill", flagged: true });
    expect(await sql("SELECT count(*)::int AS n FROM recurring_series")).toEqual([{ n: 1 }]);

    // Its wording now belongs to the series, so the next one is proposed by name.
    const next = await card(event("0.41", "2026-10-03", "Nimbus web services"), "nimbus web services 0.41 on Oct 3");
    expect(recurringLine(next.text)).toEqual(["Funded by: self · Recurring: Cloud hosting bill"]);
    await chat.tap(next, "Confirm");
    expect((await ledger.links())["Nimbus web services 2026-10-03"]).toEqual({ series: "Cloud hosting bill", flagged: true });
  });

  it("before it is added, the card proposes no series for it", async () => {
    await hostingBill();
    const shown = await card(event("0.39", "2026-09-03", "Nimbus web services"), "nimbus web services 0.39 on Sep 3");
    expect(recurringLine(shown.text)).toEqual(["Funded by: self · Recurring: not tracked yet"]);
  });

  it("a double tap on Add to links the payment once and keeps the first tap's screen", async () => {
    await hostingBill();
    await ledger.add(hosting("2026-09-03", "0.39", "Nimbus web services"));
    const screen = await addScreenFor("Sep 3 · 0.39 · Nimbus web services");
    await chat.tap(screen, "↻ Add to Cloud hosting bill");
    const after = chat.current(screen);
    await chat.retry();
    expect(chat.acks().slice(-2)).toEqual(["Added to Cloud hosting bill.", "Already in Cloud hosting bill."]);
    expect(chat.current(screen)).toEqual(after);
    expect(await sql("SELECT count(*)::int AS n FROM transactions WHERE recurring_series_id IS NOT NULL")).toEqual([{ n: 4 }]);
  });

  it("Add to never moves a payment that is already in another series", async () => {
    const internet = await ledger.track("Internet bill", "monthly", await ledger.add(hosting("2026-09-15", "64.99", "Internet bill")));
    const hostingId = await hostingBill();
    const [payment] = await ledger.add(hosting("2026-09-03", "0.39", "Nimbus web services"));
    const screen = await addScreenFor("Sep 3 · 0.39 · Nimbus web services");
    // Linked elsewhere after the screen was drawn.
    await sql("UPDATE transactions SET recurring_series_id = $1 WHERE id = $2", [internet, payment]);
    await chat.press(screen, `r:aj:${payment}:${hostingId}`);
    expect(chat.acks().at(-1)).toBe("Not added: it is already in Internet bill.");
    expect(chat.current(screen).text).toBe("That payment is already in Internet bill.");
    expect((await ledger.links())["Nimbus web services 2026-09-03"]).toEqual({ series: "Internet bill", flagged: true });
  });

  it("Add to a series deleted since the screen was drawn says so and writes nothing", async () => {
    const hostingId = await hostingBill();
    await ledger.add(hosting("2026-09-03", "0.39", "Nimbus web services"));
    const screen = await addScreenFor("Sep 3 · 0.39 · Nimbus web services");
    await sql("DELETE FROM recurring_series WHERE id = $1", [hostingId]);
    await chat.tap(screen, "↻ Add to Cloud hosting bill");
    expect(chat.acks().at(-1)).toBe("That series no longer exists.");
    expect(labels(chat.current(screen))).not.toContain("↻ Add to Cloud hosting bill");
    expect((await ledger.links())["Nimbus web services 2026-09-03"]).toEqual({ series: null, flagged: false });
  });

  it("Add to a series of another kind or another income source links nothing", async () => {
    const hostingId = await hostingBill();
    await sql(
      `INSERT INTO income_sources (name) SELECT n FROM unnest(ARRAY['Allowance', 'Side job']) n
       WHERE NOT EXISTS (SELECT 1 FROM income_sources WHERE name = n)`,
    );
    const allowance = await ledger.track(
      "Allowance",
      "monthly",
      await ledger.add({ date: "2026-09-01", type: "income", amount: "150.00", description: "Allowance", source: "Allowance" }),
    );
    const [pay] = await ledger.add({ date: "2026-10-01", type: "income", amount: "150.00", description: "Gig", source: "Side job" });
    const screen = await addScreenFor("Oct 1 · 150.00 · Gig");
    // Neither series is offered: the screen draws only those of its kind and source.
    expect(labels(chat.current(screen)).filter((l) => l.startsWith("↻ Add to"))).toEqual([]);

    // Buttons a client made up.
    await chat.press(screen, `r:aj:${pay}:${hostingId}`);
    expect(chat.acks().at(-1)).toBe("That payment can't join Cloud hosting bill: another kind, source or account.");
    await chat.press(screen, `r:aj:${pay}:${allowance}`);
    expect(chat.acks().at(-1)).toBe("That payment can't join Allowance: another kind, source or account.");
    expect((await ledger.links())["Gig 2026-10-01"]).toEqual({ series: null, flagged: false });
  });

  it("an Add to tapped from another chat links nothing", async () => {
    await hostingBill();
    await ledger.add(hosting("2026-09-03", "0.39", "Nimbus web services"));
    const screen = await addScreenFor("Sep 3 · 0.39 · Nimbus web services");
    const result = await chat.tap(screen, "↻ Add to Cloud hosting bill", STRANGER);
    expect(result.body).toBe("ignored");
    expect((await ledger.links())["Nimbus web services 2026-09-03"]).toEqual({ series: null, flagged: false });
  });

  it("the add screen shows the best 4 series and All N series lists every one", async () => {
    for (const [name, day] of [["Streaming plan", "20"], ["Phone bill", "10"], ["Gym", "25"], ["Music plan", "12"]]) {
      await ledger.track(name, "monthly", await ledger.add(hosting(`2026-08-${day}`, "9.99", name)));
    }
    await hostingBill();
    await ledger.add(hosting("2026-09-03", "0.39", "Nimbus web services"));
    const screen = await addScreenFor("Sep 3 · 0.39 · Nimbus web services");
    const joins = () => labels(chat.current(screen)).filter((l) => l.startsWith("↻ Add to"));
    expect(joins()).toHaveLength(4);
    expect(joins()[0]).toBe("↻ Add to Cloud hosting bill");
    await chat.tap(screen, "All 5 series ›");
    expect(joins()).toHaveLength(5);
    expect(gemini.calls).toEqual([]);
  });
});
