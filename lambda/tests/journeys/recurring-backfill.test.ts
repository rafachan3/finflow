import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "../integration/db-helpers.js";
import { chat, gemini, labels, ledger, useJourneys, type Reply } from "./harness.js";

vi.mock("../../src/config.js", async () => {
  const { journeyConfig } = await import("./harness.js");
  const config = journeyConfig();
  return { getConfig: async () => config };
});

useJourneys();

// Saturday 2026-10-31 in Toronto. Only Date is faked; timers stay real.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-31T16:00:00Z") });
});
afterAll(() => {
  vi.useRealTimers();
});

const internet = (date: string, description = "Internet bill", amount = "64.99", flagged = false) => ({
  date,
  amount,
  description,
  subcategory: "Internet and phone",
  flagged,
});

/** The bill's history: four earlier payments, a router rental (weak), a modem fee the import flagged (weak, ⚑). */
async function billHistory(): Promise<void> {
  await ledger.add(
    internet("2026-06-15"),
    internet("2026-07-14"),
    internet("2026-08-16", "Modem fee", "64.99", true),
    internet("2026-08-17"),
    internet("2026-09-15"),
    internet("2026-09-16", "Router rental", "64.00"),
    internet("2026-10-15", "Internet bill October"),
    { date: "2026-10-20", amount: "12.50", description: "Lunch" },
  );
}

async function open(): Promise<Reply> {
  await chat.text("/recurring");
  return chat.last();
}

/** /recurring → Add → the October bill → Monthly: the review screen. */
async function addInternet(): Promise<Reply> {
  const menu = await open();
  await chat.tap(menu, "➕ Add");
  await chat.tap(menu, "Oct 15 · 64.99 · Internet bill October");
  await chat.tap(menu, "✅ Monthly");
  return menu;
}

async function exclusions(): Promise<string[]> {
  const rows = await sql<{ e: string }>(
    `select s.name || ': ' || t.description || ' ' || t.occurred_on as e
     from recurring_exclusions x join recurring_series s on s.id = x.series_id
     join transactions t on t.id = x.transaction_id order by 1`,
  );
  return rows.map((r) => r.e);
}

const REVIEW = [
  "☐ Sep 16 · 64.00 · Router rental",
  "✅ Sep 15 · 64.99 · Internet bill",
  "✅ Aug 17 · 64.99 · Internet bill",
  "✅ ⚑ Aug 16 · 64.99 · Modem fee",
  "✅ Jul 14 · 64.99 · Internet bill",
  "✅ Jun 15 · 64.99 · Internet bill",
];

describe("verify past payments before linking", () => {
  it("Apply links the ticked payments and never offers the unticked ones again", async () => {
    await billHistory();
    const menu = await addInternet();
    expect(chat.current(menu).text).toBe(
      [
        "🧹 Internet bill: past payments that look like it",
        "6 payments. ✅ links it; ☐ leaves it out of this series for good.",
        "Ticked: same name, merchant or source. Unticked: only the same category, amount and timing. ⚑ was flagged recurring.",
      ].join("\n"),
    );
    expect(labels(chat.current(menu))).toEqual([...REVIEW, "✅ Link 5 · ignore 1", "Select all", "Later"]);

    // The owner unticks July and ticks the router rental; Apply's label follows.
    await chat.tap(menu, "✅ Jul 14 · 64.99 · Internet bill");
    expect(labels(chat.current(menu))).toContain("✅ Link 4 · ignore 2");
    await chat.tap(menu, "☐ Sep 16 · 64.00 · Router rental");
    expect(labels(chat.current(menu))).toContain("✅ Link 5 · ignore 1");
    expect(await exclusions()).toEqual([]);

    await chat.tap(menu, "✅ Link 5 · ignore 1");
    expect(chat.acks().at(-1)).toBe("Linked 5, ignored 1.");
    expect(chat.current(menu).text).toBe(
      "🧹 Internet bill\nNothing left to review: 6 payments linked, 1 ignored.\nMonthly, around the 15th.",
    );
    const links = await ledger.links();
    for (const key of [
      "Internet bill 2026-06-15", "Modem fee 2026-08-16", "Internet bill 2026-08-17", "Internet bill 2026-09-15",
      "Router rental 2026-09-16", "Internet bill October 2026-10-15",
    ]) {
      expect(links[key], key).toEqual({ series: "Internet bill", flagged: true });
    }
    expect(links["Internet bill 2026-07-14"]).toEqual({ series: null, flagged: false });
    expect(links["Lunch 2026-10-20"]).toEqual({ series: null, flagged: false });
    expect(await exclusions()).toEqual(["Internet bill: Internet bill 2026-07-14"]);

    // The ignored payment is never offered again.
    const again = await open();
    expect(again.text).not.toContain("to review");
    await chat.tap(again, "Internet bill");
    expect(labels(chat.current(again))).not.toContain(expect.stringMatching(/^🧹/));
    expect(gemini.calls).toEqual([]);
  });

  it("a double tap on Apply links nothing twice and keeps the screen the first tap left", async () => {
    await billHistory();
    const menu = await addInternet();
    await chat.tap(menu, "✅ Link 5 · ignore 1");
    const shown = chat.current(menu);
    const before = { links: await ledger.links(), exclusions: await exclusions() };

    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already applied.");
    expect(chat.current(menu)).toEqual(shown);
    expect({ links: await ledger.links(), exclusions: await exclusions() }).toEqual(before);
  });

  it("a toggle only edits the keyboard and writes nothing", async () => {
    await billHistory();
    const menu = await addInternet();
    await chat.tap(menu, "Select all");
    expect(labels(chat.current(menu))).toContain("✅ Link 6 · ignore 0");
    await chat.tap(menu, "✅ Sep 16 · 64.00 · Router rental");
    await chat.tap(menu, "Later");
    expect(chat.current(menu).buttons).toEqual([]);
    expect(chat.acks().at(-1)).toBe("Left for later: /recurring, then 🧹 Review.");
    expect(await exclusions()).toEqual([]);
    expect(Object.values(await ledger.links()).filter((l) => l.series !== null)).toHaveLength(1);

    // /recurring names what is left, and Review reopens it.
    const later = await open();
    expect(later.text).toContain("🧹 6 to review · ⚑ 1 flagged, no series");
    await chat.tap(later, "🧹 Review (6)");
    expect(labels(chat.current(later)).slice(0, 6)).toEqual(REVIEW);
  });

  it("a payment already in another series is not offered", async () => {
    await billHistory();
    const [phone] = await ledger.add(internet("2026-09-14", "Internet bill"));
    await ledger.track("Phone bill", "monthly", [phone]);
    const menu = await addInternet();
    expect(labels(chat.current(menu))).not.toContain("✅ Sep 14 · 64.99 · Internet bill");
    await chat.tap(menu, "✅ Link 5 · ignore 1");
    expect((await ledger.links())["Internet bill 2026-09-14"]).toEqual({ series: "Phone bill", flagged: true });
    expect(await exclusions()).toEqual(["Internet bill: Router rental 2026-09-16"]);
  });

  it("shows 8 at a time, and Apply moves on to the rest", async () => {
    const days = ["01-15", "02-15", "03-16", "04-15", "05-15", "06-15", "07-15", "08-17", "09-15"];
    await ledger.add(...days.map((d) => internet(`2026-${d}`)), internet("2026-10-15"));
    const list = await open();
    await chat.tap(list, "➕ Add");
    await chat.tap(list, "Oct 15 · 64.99 · Internet bill");
    await chat.tap(list, "✅ Monthly");
    expect(chat.current(list).text).toContain("Showing 8 of 9.");
    await chat.tap(list, "✅ Link 8 · ignore 0");
    expect(labels(chat.current(list))).toEqual(["✅ Jan 15 · 64.99 · Internet bill", "✅ Link 1 · ignore 0", "Select all", "Later"]);
    await chat.tap(list, "✅ Link 1 · ignore 0");
    expect(chat.current(list).text).toContain("Nothing left to review: 10 payments linked, 0 ignored.");
  });
});

describe("legacy recurring flags with no series", () => {
  it("a flagged row with no series can have its flag cleared", async () => {
    await ledger.add(
      { date: "2026-07-01", amount: "9.99", description: "Old app", flagged: true },
      { date: "2026-08-01", amount: "30.00", description: "Gift", flagged: true },
      { date: "2026-09-01", amount: "45.00", description: "Phone bill", flagged: true, subcategory: "Internet and phone" },
    );
    const menu = await open();
    expect(menu.text).toBe("↻ Recurring · 0 tracked\nNothing tracked yet.\n⚑ 3 flagged, no series");
    // With no series to review, Review goes straight to the flags.
    await chat.tap(menu, "⚑ Flagged (3)");
    expect(chat.current(menu).text).toBe(
      "⚑ Flagged recurring, in no series (3)\nShowing 1–3. Tick to clear the flag, or ➕ to make a series from that payment.",
    );
    expect(labels(chat.current(menu))).toEqual([
      "☐ Sep 1 · 45.00 · Phone bill", "➕",
      "☐ Aug 1 · 30.00 · Gift", "➕",
      "☐ Jul 1 · 9.99 · Old app", "➕",
      "Clear flag on ticked (0)", "Select all", "‹ All recurring",
    ]);

    await chat.tap(menu, "Clear flag on ticked (0)");
    expect(chat.acks().at(-1)).toBe("Tick the ones to clear first.");
    await chat.tap(menu, "☐ Aug 1 · 30.00 · Gift");
    await chat.tap(menu, "☐ Jul 1 · 9.99 · Old app");
    await chat.tap(menu, "Clear flag on ticked (2)");
    expect(chat.acks().at(-1)).toBe("Cleared 2.");
    expect(labels(chat.current(menu))[0]).toBe("☐ Sep 1 · 45.00 · Phone bill");
    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already cleared.");

    const links = await ledger.links();
    expect(links["Gift 2026-08-01"]).toEqual({ series: null, flagged: false });
    expect(links["Old app 2026-07-01"]).toEqual({ series: null, flagged: false });

    // ➕ makes a series from the one left, which takes its flag with the link.
    await chat.tap(menu, "➕");
    await chat.tap(menu, "Monthly");
    expect((await ledger.links())["Phone bill 2026-09-01"]).toEqual({ series: "Phone bill", flagged: true });
    const done = await open();
    expect(done.text).not.toContain("flagged");
    expect(labels(done)).not.toContain("⚑ Flagged (1)");
  });
});

describe("series suggestions", () => {
  const gym = ["2026-06-03", "2026-07-03", "2026-09-03", "2026-10-02"].map((date) => ({
    date,
    amount: "25.00",
    description: "Gym",
    subcategory: "Fitness",
  }));

  it("a suggestion dismissed as not recurring is never suggested again", async () => {
    await ledger.add(...gym);
    const menu = await open();
    expect(menu.text).toContain("🔎 1 suggestion");
    await chat.tap(menu, "🔎 Suggestions (1)");
    expect(chat.current(menu).text).toBe(
      "🔎 Possible recurring items (1)\n• Gym — monthly, around the 3rd · 4 payments · ~25.00",
    );
    await chat.tap(menu, "Not recurring");
    expect(chat.acks().at(-1)).toBe("Won't suggest it again.");
    expect(chat.current(menu).text).toBe("🔎 Possible recurring items\nNothing new spotted.");
    expect(await sql("select group_key from recurring_dismissed")).toHaveLength(1);
    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already dismissed.");
    expect((await open()).text).not.toContain("suggestion");
  });

  it("tracking a suggestion adds it and reviews its payments ticked", async () => {
    await ledger.add(...gym);
    const menu = await open();
    await chat.tap(menu, "🔎 Suggestions (1)");
    await chat.tap(menu, "🔎 Track Gym");
    expect(chat.current(menu).text).toContain("History: 4 payments since Jun 3, looks monthly, around the 3rd.");
    await chat.tap(menu, "✅ Monthly");
    expect(labels(chat.current(menu)).slice(0, 4)).toEqual([
      "✅ Sep 3 · 25.00 · Gym", "✅ Jul 3 · 25.00 · Gym", "✅ Jun 3 · 25.00 · Gym", "✅ Link 3 · ignore 0",
    ]);
    await chat.tap(menu, "✅ Link 3 · ignore 0");
    expect(Object.values(await ledger.links()).every((l) => l.series === "Gym")).toBe(true);
  });
});
