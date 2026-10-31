import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chat, gemini, labels, ledger, STRANGER, useJourneys, type Reply } from "./harness.js";

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

  it("a recurring button tapped from another chat does nothing", async () => {
    await threeSeries();
    const list = await open();
    const before = chat.acks().length;
    await chat.tap(list, "Internet bill", STRANGER);
    expect(chat.acks()).toHaveLength(before);
    expect(chat.current(list).text).toBe(list.text);
  });
});
