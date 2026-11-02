import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "../integration/db-helpers.js";
import { chat, invokeNudge, ledger, OWNER, STRANGER, useJourneys } from "./harness.js";

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

describe("digest buttons", () => {
  const DIGEST = [
    "↻ Recurring · Sat Oct 31",
    "",
    "Due now",
    "💳 Gym — ~25.00, Oct 30–Nov 5",
    "",
    "Not logged · 1",
    "⚠️ Gym — around Aug 3, nothing logged by Aug 8",
  ].join("\n");

  async function digest() {
    await invokeNudge(at("2026-10-31"));
    return chat.last();
  }

  const skips = () => sql<{ due: string }>("SELECT due_on::text AS due FROM recurring_skips ORDER BY due_on");

  it("skipping from the digest marks it skipped in place and Undo restores it", async () => {
    await gym();
    const sent = await digest();
    expect(sent.text).toBe(DIGEST);

    await chat.tap(sent, "⏭ Skip");
    expect(chat.current(sent).text).toBe(DIGEST.replace("💳 Gym — ~25.00, Oct 30–Nov 5", "✓ Gym · Nov 3 skipped"));
    expect(chat.current(sent).buttons.map((b) => b.text)).toEqual([
      "↩ Undo skip: Gym Nov 3",
      "🔍 Gym Aug 3: logged?",
      "⏭ Skip",
      "⏸",
      "↻ All recurring",
    ]);
    expect(chat.acks().at(-1)).toBe("Skipped Nov 3.");
    expect(await skips()).toEqual([{ due: "2026-11-03" }]);
    // Telegram resending the tap writes nothing more.
    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already skipped.");
    expect(await skips()).toHaveLength(1);

    await chat.tap(sent, "↩ Undo skip: Gym Nov 3");
    expect(chat.current(sent).text).toBe(DIGEST);
    expect(chat.acks().at(-1)).toBe("Nov 3 is expected again.");
    expect(await skips()).toEqual([]);
    await chat.retry();
    expect(chat.acks().at(-1)).toBe("Already undone.");
    // Only the one digest message, edited in place.
    expect(chat.replies()).toHaveLength(1);
  });

  it("Find with nothing logged explains how to log it", async () => {
    await gym();
    const sent = await digest();
    await chat.tap(sent, "🔍 Gym Aug 3: logged?");
    expect(chat.current(sent).text).toBe(
      'Nothing logged around Aug 3. Send it as usual ("gym 25.00 Aug 3"); the card will offer to link it.',
    );
    await chat.tap(sent, "‹ Back to digest");
    expect(chat.current(sent).text).toBe(DIGEST);
    expect(await sql("SELECT 1 FROM recurring_skips")).toEqual([]);
  });

  it("Find lists the payments around the slot and Apply links the ticked", async () => {
    await gym();
    // Logged, but never linked to the series: one around Aug 3, one long before.
    await ledger.add(gymRow("2026-08-04"), gymRow("2026-05-04"));
    const sent = await digest();
    expect(sent.text).toContain("🧹 2 past payments look like Gym");
    await chat.tap(sent, "🔍 Gym Aug 3: logged?");
    expect(chat.current(sent).text).toBe(
      "🔍 Gym around Aug 3\n1 unlinked payment looks like it. ✅ links it; ☐ leaves it out of this series for good.",
    );
    const find = chat.current(sent).buttons;
    expect(find.map((b) => b.text)).toEqual(["✅ Aug 4 · 25.00 · Gym", "✅ Link 1 · ignore 0", "‹ Back to digest"]);
    await chat.tap(sent, "✅ Link 1 · ignore 0");
    expect(chat.acks().at(-1)).toBe("Linked 1, ignored 0.");
    expect((await ledger.links())["Gym 2026-08-04"]).toEqual({ series: "Gym", flagged: true });
    // Back on the digest: Aug 3 is logged now, the May payment still waits for review.
    expect(chat.current(sent).text).toBe(
      ["↻ Recurring · Sat Oct 31", "", "Due now", "💳 Gym — ~25.00, Oct 30–Nov 5", "", "🧹 1 past payment looks like Gym"].join("\n"),
    );

    // A second Apply carries the digest's buttons, not Find's toggles: nothing more is written.
    await chat.press(sent, find[1].data);
    expect(chat.acks().at(-1)).toBe("Already applied.");
    expect((await ledger.links())["Gym 2026-05-04"]).toEqual({ series: null, flagged: false });
    expect(await sql("SELECT 1 FROM recurring_exclusions")).toEqual([]);
  });

  it("a stale or repeated digest button writes nothing", async () => {
    const id = await gym();
    const sent = await digest();
    // The Nov 3 payment was logged after the digest went out.
    const [paid] = await ledger.add(gymRow("2026-11-01"));
    await sql("UPDATE transactions SET recurring_series_id = $1 WHERE id = $2", [id, paid]);
    await chat.tap(sent, "⏭ Skip");
    expect(chat.acks().at(-1)).toBe("Already logged: nothing to skip.");

    // A deleted series.
    await sql("UPDATE transactions SET recurring_series_id = NULL WHERE id = $1", [paid]);
    await sql("DELETE FROM recurring_series WHERE id = $1", [id]);
    await chat.tap(sent, "⏭ Skip");
    expect(chat.acks().at(-1)).toBe("That series no longer exists.");

    // A message that is not a digest the bot sent.
    await sql("DELETE FROM nudge_runs");
    await chat.tap(sent, "⏭ Skip");
    expect(chat.acks().at(-1)).toBe("That digest is no longer current. Open /recurring.");
    expect(await sql("SELECT 1 FROM recurring_skips")).toEqual([]);
    expect(chat.current(sent).text).toBe(DIGEST);
  });

  it("a skip writes only at a payment's own date: an off-date or upcoming one writes nothing", async () => {
    vi.setSystemTime(new Date(at("2027-02-20")));
    try {
      const months = ["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"];
      const id = await ledger.track("Gym", "monthly", await ledger.add(...months.map(gymRow)));
      await invokeNudge(at("2027-02-20"));
      const sent = chat.last();
      expect(sent.text).toContain("⚠️ Gym — around Feb 1");
      // Feb 16 is within half a month of the not-logged Feb 1, but nearer the upcoming Mar 1:
      // stored, it would settle Mar 1 and leave Feb 1 not logged.
      await chat.press(sent, `r:dk:${id}:20270216`);
      expect(chat.acks().at(-1)).toBe("That button is out of date. Open /recurring.");
      await chat.press(sent, `r:dk:${id}:20270301`);
      expect(chat.acks().at(-1)).toBe("Nothing expected around Mar 1.");
      expect(await skips()).toEqual([]);

      await chat.tap(sent, "⏭ Skip");
      expect(chat.acks().at(-1)).toBe("Skipped Feb 1.");
      expect(await skips()).toEqual([{ due: "2027-02-01" }]);
      expect(chat.current(sent).text).toContain("✓ Gym · Feb 1 skipped");
    } finally {
      vi.setSystemTime(new Date(at("2026-10-31")));
    }
  });

  it("Undo removes only a skip recorded on or after the digest's day", async () => {
    const id = await gym();
    // Aug 3 was skipped before this digest's day: settled, listed nowhere, no Undo drawn for it.
    await sql("INSERT INTO recurring_skips (series_id, due_on, skipped_at) VALUES ($1, '2026-08-03', '2026-10-20T16:00:00Z')", [id]);
    const sent = await digest();
    expect(sent.text).not.toContain("Aug 3");
    await chat.press(sent, `r:du:${id}:20260803`);
    expect(chat.acks().at(-1)).toBe("That button is out of date. Open /recurring.");
    expect(await skips()).toEqual([{ due: "2026-08-03" }]);
    expect(chat.current(sent).text).toBe(sent.text);

    // Yesterday's digest, redrawn now, shows today's skip with Undo, so its Undo may remove it.
    await invokeNudge(at("2026-10-30"));
    const yesterday = chat.last();
    await chat.tap(sent, "⏭ Skip");
    expect(await skips()).toEqual([{ due: "2026-08-03" }, { due: "2026-11-03" }]);
    await chat.press(yesterday, "r:dv");
    await chat.tap(yesterday, "↩ Undo skip: Gym");
    expect(chat.acks().at(-1)).toBe("Nov 3 is expected again.");
    expect(await skips()).toEqual([{ due: "2026-08-03" }]);
  });

  it("a digest button tapped from another chat does nothing", async () => {
    await gym();
    const sent = await digest();
    await chat.tap(sent, "⏭ Skip", STRANGER);
    expect(chat.acks()).toEqual([]);
    expect(await sql("SELECT 1 FROM recurring_skips")).toEqual([]);
    expect(chat.current(sent).text).toBe(DIGEST);
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
