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

const bill = (date: string, amount = "64.99", description = "Internet bill") => ({
  date,
  amount,
  description,
  subcategory: "Internet and phone",
});

/** Three series the owner tracks: a monthly bill, a biweekly salary, and a gym with a month not logged. */
async function threeSeries(): Promise<{ internet: number; salary: number; gym: number }> {
  const internet = await ledger.track(
    "Internet bill",
    "monthly",
    await ledger.add(bill("2026-06-15"), bill("2026-07-14"), bill("2026-08-17"), bill("2026-09-15"), bill("2026-10-15")),
  );
  const fridays = ["06-05", "06-19", "07-03", "07-17", "07-31", "08-14", "08-28", "09-11", "09-25", "10-09", "10-23"];
  const salary = await ledger.track(
    "Salary",
    "biweekly",
    await ledger.add(
      ...fridays.map((d) => ({ date: `2026-${d}`, type: "income" as const, amount: "2000.00", description: "Pay", source: "Salary" })),
    ),
  );
  const gymDays = ["2026-06-03", "2026-07-03", "2026-09-03", "2026-10-02"];
  const gym = await ledger.track(
    "Gym",
    "monthly",
    await ledger.add(...gymDays.map((date) => ({ date, amount: "25.00", description: "Gym", subcategory: "Fitness" }))),
  );
  return { internet, salary, gym };
}

async function open(): Promise<Reply> {
  await chat.text("/recurring");
  return chat.last();
}

describe("/recurring list and detail", () => {
  it("/recurring lists each series with its next window and opens its detail in place", async () => {
    await threeSeries();
    const list = await open();
    expect(list.text).toBe(
      [
        "↻ Recurring · 3 tracked",
        "Expenses",
        "• Gym — monthly, around the 3rd · ~25.00 · 1 not logged",
        "• Internet bill — monthly, around the 15th · ~64.99 · next Nov 13–17",
        "Income",
        "• Salary — every 2 weeks, Fri · ~2,000.00 · next Nov 5–9",
      ].join("\n"),
    );
    expect(labels(list)).toEqual(expect.arrayContaining(["Gym", "Internet bill", "Salary"]));

    await chat.tap(list, "Internet bill");
    expect(chat.current(list).text).toBe(
      [
        "↻ Internet bill — expense · Bills › Internet and phone",
        "Monthly, around the 15th",
        "Usually 64.99 (61.74–68.24)",
        "5 payments since Jun 15 · last Oct 15",
        "Next: Nov 13–17 · not logged: none",
      ].join("\n"),
    );
    // Edited in place: no new message.
    expect(chat.replies()).toHaveLength(1);

    await chat.tap(list, "‹ All recurring");
    expect(chat.current(list).text).toBe(list.text);
    await chat.tap(list, "Gym");
    expect(chat.current(list).text).toContain("Next: Oct 30–Nov 5 · not logged: Aug 3");
    expect(gemini.calls).toEqual([]);
  });

  it("says so when nothing is tracked yet", async () => {
    expect((await open()).text).toBe("↻ Recurring · 0 tracked\nNothing tracked yet.");
  });

  it("a paused series shows its pause in the list and detail", async () => {
    const ids = await ledger.add(bill("2026-06-15", "45.00", "Phone bill"), bill("2026-07-15", "45.00", "Phone bill"));
    const phone = await ledger.track("Phone bill", "monthly", ids);
    await sql("insert into recurring_pauses (series_id, paused_from, resumed_on) values ($1, '2026-09-01', '2026-12-01')", [phone]);
    const list = await open();
    expect(list.text).toContain("• Phone bill — ⏸ paused since Sep 1, resumes Dec 1");
    expect(labels(list)).toContain("Phone bill ⏸");
    await chat.tap(list, "Phone bill ⏸");
    expect(chat.current(list).text).toContain("\n⏸ paused since Sep 1, resumes Dec 1");
    expect(labels(chat.current(list))).toEqual(["▶️ Resume today", "✏️ Rename", "🗑 Delete", "‹ All recurring"]);
  });

  it("a name or description with &, < or > is shown as typed in every HTML screen", async () => {
    await ledger.add({ date: "2026-10-15", amount: "9.99", description: "A&B <fun> > plan 2" });
    const list = await open();
    await chat.tap(list, "➕ Add");
    await chat.tap(list, "Oct 15 · 9.99 · A&B <fun> > plan 2");
    expect(chat.current(list).text).toContain("From Oct 15 · 9.99 · A&B <fun> > plan 2\nName: A&B <fun> > plan (rename after)");
    await chat.tap(list, "Monthly");
    expect(chat.current(list).text).toContain("🧹 A&B <fun> > plan\n");
    await chat.tap(list, "‹ All recurring");
    expect(chat.current(list).text).toContain("• A&B <fun> > plan — monthly, around the 15th");
    await chat.tap(list, "A&B <fun> > plan");
    expect(chat.current(list).text.split("\n")[0]).toBe("↻ A&B <fun> > plan — expense · Food and drink › Groceries");
  });

  it("a delete tapped from another chat deletes nothing", async () => {
    await threeSeries();
    const list = await open();
    await chat.tap(list, "Internet bill");
    await chat.tap(list, "🗑 Delete");
    const before = chat.acks().length;
    await chat.tap(list, "🗑 Delete", STRANGER);
    expect(chat.acks()).toHaveLength(before);
    expect(await sql("select count(*)::int as n from recurring_series")).toEqual([{ n: 3 }]);
  });

  it("a recurring button tapped from another chat does nothing", async () => {
    await threeSeries();
    const list = await open();
    const before = chat.acks().length;
    await chat.tap(list, "Internet bill", STRANGER);
    expect(chat.acks()).toHaveLength(before);
    expect(chat.current(list).text).toBe(list.text);
  });
});

describe("add from a saved transaction", () => {
  it("adding from a saved transaction suggests monthly and links it", async () => {
    await ledger.add(
      bill("2026-06-15"), bill("2026-07-14"), bill("2026-08-17"), bill("2026-09-15"),
      bill("2026-10-15", "64.99", "Internet bill October"),
      { date: "2026-10-20", amount: "12.50", description: "Lunch" },
    );
    const list = await open();
    await chat.tap(list, "➕ Add");
    expect(labels(chat.current(list)).slice(0, 2)).toEqual(["Oct 20 · 12.50 · Lunch", "Oct 15 · 64.99 · Internet bill October"]);

    await chat.tap(list, "Oct 15 · 64.99 · Internet bill October");
    expect(chat.current(list).text).toBe(
      [
        "➕ New recurring item",
        "From Oct 15 · 64.99 · Internet bill October",
        "Name: Internet bill (rename after)",
        "History: 5 payments since Jun 15, looks monthly, around the 15th.",
      ].join("\n"),
    );
    expect(labels(chat.current(list))).toEqual([
      "✅ Monthly", "Twice a month", "Every 2 weeks", "Weekly", "Quarterly", "Yearly", "☐ Amount varies", "‹ Back",
    ]);

    // The toggle edits only the keyboard.
    await chat.tap(list, "☐ Amount varies");
    expect(labels(chat.current(list))).toContain("✅ Amount varies");
    await chat.tap(list, "✅ Amount varies");
    expect(await sql("select count(*)::int as n from recurring_series")).toEqual([{ n: 0 }]);

    await chat.tap(list, "✅ Monthly");
    expect(chat.acks().at(-1)).toBe("Tracking Internet bill.");
    expect(await sql("select name, kind::text, cadence::text, amount_varies from recurring_series")).toEqual([
      { name: "Internet bill", kind: "expense", cadence: "monthly", amount_varies: false },
    ]);
    const links = await ledger.links();
    expect(links["Internet bill October 2026-10-15"]).toEqual({ series: "Internet bill", flagged: true });
    // The other four wait for the owner's review.
    expect(links["Internet bill 2026-09-15"]).toEqual({ series: null, flagged: false });

    // A double tap creates nothing more.
    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already tracked as Internet bill.");
    expect(await sql("select count(*)::int as n from recurring_series")).toEqual([{ n: 1 }]);
    expect(gemini.calls).toEqual([]);
  });

  it("a payment with too little history asks for the cadence, and amount varies is stored", async () => {
    await ledger.add({ date: "2026-10-30", type: "income", amount: "3.12", description: "Savings interest", source: "Refund" });
    const list = await open();
    await chat.tap(list, "➕ Add");
    await chat.tap(list, "Oct 30 · 3.12 · Savings interest");
    expect(chat.current(list).text).toContain("Name: Refund (rename after)\nHistory: 1 payment, not enough to tell. Pick how often.");
    await chat.tap(list, "☐ Amount varies");
    await chat.tap(list, "Monthly");
    expect(await sql("select name, kind::text, amount_varies from recurring_series")).toEqual([
      { name: "Refund", kind: "income", amount_varies: true },
    ]);
    expect(labels(chat.current(list))).toContain("⏳ Next payment not until…");
  });
});

/** A salary that stopped: the last pay was Oct 9, so Oct 23 is not logged. */
async function stoppedSalary(): Promise<number> {
  const fridays = ["07-31", "08-14", "08-28", "09-11", "09-25", "10-09"];
  return ledger.track(
    "Salary",
    "biweekly",
    await ledger.add(
      ...fridays.map((d) => ({ date: `2026-${d}`, type: "income" as const, amount: "2000.00", description: "Pay", source: "Salary" })),
    ),
  );
}

async function pauses(): Promise<{ from: string; until: string | null }[]> {
  return sql(`select paused_from::text as "from", resumed_on::text as "until" from recurring_pauses order by paused_from`);
}

describe("pause, resume, rename and delete", () => {
  it("pausing a series since its last payment stops it being missed", async () => {
    await stoppedSalary();
    const list = await open();
    expect(list.text).toContain("• Salary — every 2 weeks, Fri · ~2,000.00 · 1 not logged");
    await chat.tap(list, "Salary");
    expect(chat.current(list).text).toContain("not logged: Oct 23");

    await chat.tap(list, "⏸ Pause");
    expect(labels(chat.current(list))).toEqual(["Today", "From Oct 23, first not logged", "Cancel"]);
    await chat.tap(list, "From Oct 23, first not logged");
    expect(chat.current(list).text).toBe("⏸ Pause Salary from Oct 23\nUntil when?");
    expect(labels(chat.current(list))).toEqual(["Until I resume", "Until Nov 30", "Until Jan 31 2027", "Until a date I type…", "Cancel"]);
    expect(await pauses()).toEqual([]);

    await chat.tap(list, "Until I resume");
    expect(chat.acks().at(-1)).toBe("Paused from Oct 23.");
    expect(await pauses()).toEqual([{ from: "2026-10-23", until: null }]);
    expect(chat.current(list).text).toContain("not logged: none\n⏸ paused since Oct 23");

    // Telegram resending the tap writes no second pause and leaves the screen.
    const shown = chat.current(list);
    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already paused.");
    expect(await pauses()).toHaveLength(1);
    expect(chat.current(list)).toEqual(shown);

    await chat.tap(list, "▶️ Resume today");
    expect(chat.acks().at(-1)).toBe("Resumed.");
    expect(await pauses()).toEqual([{ from: "2026-10-23", until: "2026-10-31" }]);
    // The paused fortnight stays excused after the resume.
    expect(chat.current(list).text).toContain("Next: Nov 5–9 · not logged: none");
    expect(labels(chat.current(list))[0]).toBe("⏸ Pause");
  });

  it("a pause that overlaps an earlier one is refused and nothing is written", async () => {
    await stoppedSalary();
    const first = await open();
    const second = await open();
    await chat.tap(first, "Salary");
    await chat.tap(second, "Salary");
    await chat.tap(first, "⏸ Pause");
    await chat.tap(first, "Today");
    await chat.tap(first, "Until I resume");

    // The second message still offers Pause, from before the first pause.
    await chat.tap(second, "⏸ Pause");
    await chat.tap(second, "From Oct 23, first not logged");
    await chat.tap(second, "Until Nov 30");
    expect(chat.acks().at(-1)).toBe("Overlaps an earlier pause. Nothing changed.");
    expect(await pauses()).toEqual([{ from: "2026-10-31", until: null }]);
    expect(chat.current(second).text).toContain("⏸ paused since Oct 31");
  });

  it("a Today button tapped days after it was drawn uses the day of the tap", async () => {
    const salary = await stoppedSalary();
    await sql("insert into recurring_pauses (series_id, paused_from) values ($1, '2026-10-23')", [salary]);
    const list = await open();
    await chat.tap(list, "Salary ⏸");
    vi.setSystemTime(new Date("2026-11-02T16:00:00Z"));
    await chat.tap(list, "▶️ Resume today");
    expect(await pauses()).toEqual([{ from: "2026-10-23", until: "2026-11-02" }]);
  });

  it("resuming from a payment logged during the pause counts the pause up to it", async () => {
    const salary = await stoppedSalary();
    await sql("insert into recurring_pauses (series_id, paused_from) values ($1, '2026-10-10')", [salary]);
    const [back] = await ledger.add({ date: "2026-10-23", type: "income", amount: "2000.00", description: "Pay", source: "Salary" });
    await sql("update transactions set recurring_series_id = $1 where id = $2", [salary, back]);

    const list = await open();
    await chat.tap(list, "Salary ⏸");
    expect(chat.current(list).text).toContain("Logged while paused: Oct 23. Resume from then?");
    await chat.tap(list, "▶️ Resume from Oct 23");
    expect(await pauses()).toEqual([{ from: "2026-10-10", until: "2026-10-23" }]);
    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Not paused.");
  });

  it("a series that bills again from a later date is paused until the day the owner types, never missed before it", async () => {
    // A streaming subscription went free for a while; billing restarts on a known day.
    const ids = await ledger.add(
      bill("2026-07-05", "16.99", "Streaming subscription"),
      bill("2026-08-05", "16.99", "Streaming subscription"),
      bill("2026-09-05", "16.99", "Streaming subscription"),
    );
    await ledger.track("Streaming subscription", "monthly", ids);
    const list = await open();
    await chat.tap(list, "Streaming subscription");
    expect(chat.current(list).text).toContain("not logged: Oct 5");
    await chat.tap(list, "⏸ Pause");
    await chat.tap(list, "From Oct 5, first not logged");
    await chat.tap(list, "Until a date I type…");
    const prompt = chat.last();
    expect(prompt.text).toBe("Pause #1 from 2026-10-05 (Streaming subscription): reply with the day payments start again, e.g. Dec 15.");
    expect(await pauses()).toEqual([]);

    await chat.reply(prompt, "2026-10-01");
    expect(chat.last().text).toBe("The pause starts Oct 5: send a later day, like Dec 15. Tap ⏸ Pause to try again.");
    await chat.reply(prompt, "not a date");
    expect(chat.last().text).toBe("Send the day payments start again, like Dec 15 or 2027-01-15. Tap ⏸ Pause to try again.");
    expect(await pauses()).toEqual([]);

    // A month and day alone is its next occurrence: January is next year's.
    await chat.reply(prompt, "Jan 5");
    expect(chat.last().text).toBe("Paused from Oct 5 until Jan 5 2027.");
    expect(await pauses()).toEqual([{ from: "2026-10-05", until: "2027-01-05" }]);
    await chat.reply(prompt, "Jan 5");
    expect(await pauses()).toHaveLength(1);
    await chat.reply(prompt, "Feb 1");
    expect(chat.last().text).toBe("That overlaps an earlier pause. Nothing changed.");

    expect((await open()).text).toContain("• Streaming subscription — ⏸ paused since Oct 5, resumes Jan 5 2027");
    expect(gemini.calls).toEqual([]);
  });

  it("a typed end with no year is its next occurrence after today, even for a pause that began over a year ago", async () => {
    const ids = await ledger.add(
      bill("2025-07-15", "45.00", "Phone bill"),
      bill("2025-08-15", "45.00", "Phone bill"),
    );
    await ledger.track("Phone bill", "monthly", ids);
    const list = await open();
    await chat.tap(list, "Phone bill");
    await chat.tap(list, "⏸ Pause");
    await chat.tap(list, "From Sep 15 2025, first not logged");
    await chat.tap(list, "Until a date I type…");
    await chat.reply(chat.last(), "Dec 15");
    expect(chat.last().text).toBe("Paused from Sep 15 2025 until Dec 15.");
    expect(await pauses()).toEqual([{ from: "2025-09-15", until: "2026-12-15" }]);
  });

  it("today or yesterday typed for a pause that starts today is refused, not read as next year", async () => {
    await threeSeries();
    const list = await open();
    await chat.tap(list, "Internet bill");
    await chat.tap(list, "⏸ Pause");
    await chat.tap(list, "Today");
    await chat.tap(list, "Until a date I type…");
    const prompt = chat.last();
    for (const typed of ["today", "yesterday", "Oct 31 2026"]) {
      await chat.reply(prompt, typed);
      expect(chat.last().text, typed).toBe("The pause starts Oct 31: send a later day, like Dec 15. Tap ⏸ Pause to try again.");
    }
    expect(await pauses()).toEqual([]);
    expect(gemini.calls).toEqual([]);
  });

  it("renaming by replying to the prompt keeps its links", async () => {
    const { internet } = await threeSeries();
    const list = await open();
    await chat.tap(list, "Internet bill");
    await chat.tap(list, "✏️ Rename");
    const prompt = chat.last();
    expect(prompt.text).toBe(`Rename #${internet} (Internet bill): reply with the new name.`);
    expect(chat.acks().at(-1)).toBe("Reply with the new name.");

    await chat.reply(prompt, "  Home   internet ");
    expect(chat.last().text).toBe("Renamed to Home internet.");
    await chat.reply(prompt, "gym");
    expect(chat.last().text).toBe("Another series is already called gym. Pick another name.");
    await chat.reply(prompt, "x".repeat(61));
    expect(chat.last().text).toBe("A name is 1 to 60 characters. Tap ✏️ Rename to try again.");

    const links = Object.values(await ledger.links()).filter((l) => l.series === "Home internet");
    expect(links).toHaveLength(5);
    expect(links.every((l) => l.flagged)).toBe(true);
    expect(gemini.calls).toEqual([]);
  });

  it("a rename reply for a deleted series says so", async () => {
    const { internet } = await threeSeries();
    const list = await open();
    await chat.tap(list, "Internet bill");
    await chat.tap(list, "✏️ Rename");
    const prompt = chat.last();
    await sql("delete from recurring_series where id = $1", [internet]);
    await chat.reply(prompt, "Home internet");
    expect(chat.last().text).toBe("That series no longer exists.");
  });

  it("deleting a series asks first, then clears is_recurring on its payments", async () => {
    await threeSeries();
    const list = await open();
    await chat.tap(list, "Internet bill");
    await chat.tap(list, "🗑 Delete");
    expect(chat.current(list).text).toBe(
      "🗑 Delete Internet bill?\nIts 5 payments stay saved and are no longer marked recurring.",
    );
    await chat.tap(list, "Cancel");
    expect(Object.values(await ledger.links()).filter((l) => l.series === "Internet bill")).toHaveLength(5);

    await chat.tap(list, "🗑 Delete");
    await chat.tap(list, "🗑 Delete");
    expect(chat.current(list).text).toBe("Deleted Internet bill. Its 5 payments are no longer marked recurring.");
    const bills = Object.entries(await ledger.links()).filter(([k]) => k.startsWith("Internet bill"));
    expect(bills.map(([, l]) => l)).toEqual(Array(5).fill({ series: null, flagged: false }));
    expect((await ledger.transactions()).length).toBe(20);

    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already deleted.");
    await chat.tap(list, "‹ All recurring");
    expect(chat.current(list).text).not.toContain("Internet bill");
  });
});

describe("replies to a /recurring prompt", () => {
  /** What Gemini reads from any message here: one valid purchase. */
  function scriptPurchase(): void {
    const recorded = golden("text-with-note").recorded as { events: object[] };
    gemini.extract = { events: [recorded.events[0]] };
  }

  async function renamePrompt(): Promise<Reply> {
    await threeSeries();
    const list = await open();
    await chat.tap(list, "Internet bill");
    await chat.tap(list, "✏️ Rename");
    return chat.last();
  }

  async function pausePrompt(): Promise<Reply> {
    await threeSeries();
    const list = await open();
    await chat.tap(list, "Internet bill");
    await chat.tap(list, "⏸ Pause");
    await chat.tap(list, "Today");
    await chat.tap(list, "Until a date I type…");
    return chat.last();
  }

  async function names(): Promise<string[]> {
    return (await sql<{ name: string }>("select name from recurring_series order by name")).map((r) => r.name);
  }

  it("a receipt photo sent as a reply to a rename prompt is still saved as an expense", async () => {
    const prompt = await renamePrompt();
    scriptPurchase();
    await chat.reply(prompt, "lunch", "photo");
    expect(gemini.calls).toHaveLength(1);
    expect(labels(chat.last())).toContain("Confirm");
    expect(await names()).toEqual(["Gym", "Internet bill", "Salary"]);
  });

  it("an expense typed as a reply to a pause prompt is saved, not taken as the date", async () => {
    const prompt = await pausePrompt();
    scriptPurchase();
    await chat.reply(prompt, "12.50 lunch with the team");
    expect(gemini.calls).toHaveLength(1);
    expect(labels(chat.last())).toContain("Confirm");
    expect(await pauses()).toEqual([]);
  });

  it("a long expense typed as a reply to a rename prompt is saved, not refused as a name", async () => {
    const prompt = await renamePrompt();
    scriptPurchase();
    await chat.reply(prompt, "groceries 45.20 at the market on the way home from the office today");
    expect(gemini.calls).toHaveLength(1);
    expect(await names()).toEqual(["Gym", "Internet bill", "Salary"]);
  });

  it("lunch 12.50 sent as a reply to a rename prompt is saved as an expense, and Internet 2 still renames", async () => {
    const prompt = await renamePrompt();
    scriptPurchase();
    await chat.reply(prompt, "lunch 12.50");
    expect(gemini.calls).toHaveLength(1);
    expect(labels(chat.last())).toContain("Confirm");
    expect(await names()).toEqual(["Gym", "Internet bill", "Salary"]);

    await chat.reply(prompt, "Internet 2");
    expect(chat.last().text).toBe("Renamed to Internet 2.");
    expect(gemini.calls).toHaveLength(1);
    expect(await names()).toEqual(["Gym", "Internet 2", "Salary"]);
  });

  it("a reply to a prompt older than 15 minutes goes to extraction", async () => {
    const prompt = await renamePrompt();
    vi.setSystemTime(new Date(NOW.getTime() + 15 * 60_000));
    scriptPurchase();
    await chat.reply(prompt, "Home internet");
    expect(gemini.calls).toHaveLength(1);
    expect(await names()).toEqual(["Gym", "Internet bill", "Salary"]);
  });

  it("a rename reply while a card waits for a date renames the series and leaves the card waiting", async () => {
    const prompt = await renamePrompt();
    scriptPurchase();
    await chat.text("lunch 14");
    await chat.tap(chat.last(), "Fix date");
    const calls = gemini.calls.length;

    await chat.reply(prompt, "Home internet");
    expect(chat.last().text).toBe("Renamed to Home internet.");
    expect(gemini.calls).toHaveLength(calls);
    expect((await ledger.ingestions()).map((i) => i.status)).toEqual(["awaiting_date"]);
  });
});
