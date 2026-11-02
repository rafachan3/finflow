import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "../integration/db-helpers.js";
import { chat, invokeNudge, ledger, OWNER, useJourneys } from "./harness.js";

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

// The schedule fires at 09:00 Toronto; Oct 31 2026 is still daylight time (UTC-4).
const at = (day: string) => `${day}T13:00:00Z`;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(at("2026-10-31")) });
});
afterAll(() => {
  vi.useRealTimers();
});

const FRIDAYS = ["06-05", "06-19", "07-03", "07-17", "07-31", "08-14", "08-28", "09-11", "09-25", "10-09", "10-23"];
const gymRow = (date: string) => ({ date, amount: "25.00", description: "Gym", subcategory: "Fitness" });
const bill = (date: string) => ({ date, amount: "64.99", description: "Internet bill", subcategory: "Internet and phone" });

/** A gym with its Aug 3 payment never logged. */
async function gym(): Promise<number> {
  return ledger.track(
    "Gym",
    "monthly",
    await ledger.add(...["2026-06-03", "2026-07-03", "2026-09-03", "2026-10-02"].map(gymRow)),
  );
}

async function salary(): Promise<number> {
  return ledger.track(
    "Salary",
    "biweekly",
    await ledger.add(
      ...FRIDAYS.map((d) => ({ date: `2026-${d}`, type: "income" as const, amount: "2000.00", description: "Pay", source: "Salary" })),
    ),
  );
}

/** Interest posted on the last day of the month, a different amount each time. */
async function interest(): Promise<number> {
  await sql(
    `INSERT INTO income_sources (name) SELECT 'Savings interest'
     WHERE NOT EXISTS (SELECT 1 FROM income_sources WHERE name = 'Savings interest')`,
  );
  const paid = [
    ["2026-06-30", "3.12"],
    ["2026-07-31", "3.40"],
    ["2026-08-31", "3.38"],
    ["2026-09-30", "3.55"],
  ];
  const id = await ledger.track(
    "Savings interest",
    "monthly",
    await ledger.add(
      ...paid.map(([date, amount]) => ({ date, amount, type: "income" as const, description: "Interest", source: "Savings interest" })),
    ),
  );
  await sql("UPDATE recurring_series SET amount_varies = true WHERE id = $1", [id]);
  return id;
}

/** An internet bill tracked from August, with three earlier bills not linked yet. */
async function internet(): Promise<number> {
  await ledger.add(bill("2026-05-15"), bill("2026-06-15"), bill("2026-07-14"));
  return ledger.track("Internet bill", "monthly", await ledger.add(bill("2026-08-17"), bill("2026-09-15"), bill("2026-10-15")));
}

function runs() {
  return sql<{ run_date: string; status: string; attempts: number; sent: boolean }>(
    `SELECT run_date::text, status, attempts, message_id IS NOT NULL AS sent FROM nudge_runs ORDER BY run_date`,
  );
}

describe("the daily digest", () => {
  it("the digest lists what is due, coming and not logged", async () => {
    await gym();
    await salary();
    await interest();
    await internet();
    await invokeNudge(at("2026-10-31"));

    expect(chat.replies()).toHaveLength(1);
    expect(chat.last().text).toBe(
      [
        "↻ Recurring · Sat Oct 31",
        "",
        "Due now",
        "💰 Savings interest — amount varies, log it when it posts (by Nov 2)",
        "💳 Gym — ~25.00, Oct 30–Nov 5",
        "",
        "Coming up (7 days)",
        "Nov 5–9  Salary — ~2,000.00",
        "",
        "Not logged · 1",
        "⚠️ Gym — around Aug 3, nothing logged by Aug 8",
        "",
        "🧹 3 past payments look like Internet bill",
      ].join("\n"),
    );
    expect(chat.last().buttons.map((b) => b.text)).toEqual([
      "🔍 Savings interest: logged?",
      "⏭ Skip",
      "🔍 Gym Nov 3: logged?",
      "⏭ Skip",
      "🔍 Gym Aug 3: logged?",
      "⏭ Skip",
      "⏸",
      "🧹 Review (3)",
      "↻ All recurring",
    ]);
    expect(await runs()).toEqual([{ run_date: "2026-10-31", status: "sent", attempts: 1, sent: true }]);
    const [{ chat_id }] = await sql<{ chat_id: string }>("SELECT chat_id::text FROM nudge_runs");
    expect(Number(chat_id)).toBe(OWNER);
  });

  it("a day with nothing due sends no digest", async () => {
    await salary();
    // Oct 25: the Oct 23 pay is logged and the next window opens Nov 5.
    await invokeNudge(at("2026-10-25"));
    expect(chat.replies()).toEqual([]);
    expect(await runs()).toEqual([{ run_date: "2026-10-25", status: "empty", attempts: 1, sent: false }]);
  });

  it("a paused series is not listed as not logged", async () => {
    const id = await gym();
    await sql("INSERT INTO recurring_pauses (series_id, paused_from, resumed_on) VALUES ($1, '2026-07-20', '2026-08-20')", [id]);
    await invokeNudge(at("2026-10-31"));
    expect(chat.last().text).not.toContain("Not logged");
    expect(chat.last().text).toContain("💳 Gym — ~25.00, Oct 30–Nov 5");
  });

  it("the digest rings only when an item became due or missed today", async () => {
    await gym();
    await interest();
    // Oct 30: the gym's window opens (a fixed expense).
    await invokeNudge(at("2026-10-30"));
    expect(chat.rang()).toBe(true);
    // Oct 31: nothing new, the same items listed.
    await invokeNudge(at("2026-10-31"));
    expect(chat.replies()).toHaveLength(2);
    expect(chat.rang()).toBe(false);
  });

  it("notes a day with no digest", async () => {
    await gym();
    await sql(
      `INSERT INTO nudge_runs (run_date, chat_id, status, message_id) VALUES ('2026-10-28', $1, 'sent', 900)`,
      [OWNER],
    );
    // Oct 29 ran; Oct 30 has no run at all (the database was down all hour).
    await sql(`INSERT INTO nudge_runs (run_date, chat_id, status) VALUES ('2026-10-29', $1, 'empty')`, [OWNER]);
    await invokeNudge(at("2026-10-31"));
    expect(chat.last().text.endsWith("⚠️ No digest on Oct 30")).toBe(true);
  });
});

describe("sending once a day", () => {
  it("a second invocation for the same day sends nothing", async () => {
    await gym();
    await invokeNudge(at("2026-10-31"));
    await invokeNudge(at("2026-10-31"));
    expect(chat.replies()).toHaveLength(1);
    expect(await runs()).toEqual([{ run_date: "2026-10-31", status: "sent", attempts: 1, sent: true }]);
  });

  it("a refused send is retried once the schedule retries", async () => {
    await gym();
    chat.failNextSends(1);
    await expect(invokeNudge(at("2026-10-31"))).rejects.toThrow("Telegram refused 1 digest");
    expect(await runs()).toEqual([{ run_date: "2026-10-31", status: "failed", attempts: 1, sent: false }]);
    expect(chat.replies()).toEqual([]);

    await invokeNudge(at("2026-10-31"));
    expect(chat.replies()).toHaveLength(1);
    expect(await runs()).toEqual([{ run_date: "2026-10-31", status: "sent", attempts: 2, sent: true }]);
  });

  it("a send that may have gone out is not sent again", async () => {
    await gym();
    chat.dropNextSends(1);
    // No answer is not a refusal: the run stays claimed and nothing throws.
    await invokeNudge(at("2026-10-31"));
    await invokeNudge(at("2026-10-31"));
    expect(chat.replies()).toEqual([]);
    expect(await runs()).toEqual([{ run_date: "2026-10-31", status: "claimed", attempts: 1, sent: false }]);
  });
});
