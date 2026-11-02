/**
 * The scheduled nudge function, `finflow-nudge` (design §F): at 09:00 Toronto
 * it sends each allowlisted chat the day's recurring digest, at most once.
 * No Gemini, no S3, no Function URL; taps on the digest's buttons reach the
 * webhook like any other button.
 *
 * Delivery is at-least-once (Scheduler and Lambda both retry), so each chat's
 * run is claimed in `nudge_runs` before the send:
 *
 * - claimed, then sent → 'sent' with its message id;
 * - nothing to say → 'empty', no message;
 * - Telegram answered with an error → 'failed' and the function throws, so
 *   the schedule's retry claims it again (at most three attempts);
 * - no answer (timeout, reset) → left 'claimed' and not retried: the digest
 *   may have arrived, and a lost day costs less than a duplicate.
 *
 * Logs carry the day, statuses and counts, never names or amounts.
 */
import { todayToronto } from "./commands.js";
import { getNudgeConfig } from "./config.js";
import { claimRun, finishRun } from "./recurring-db.js";
import { loadDigest } from "./recurring-digest.js";
import { sendMessage, TelegramError } from "./telegram.js";

export type NudgeEvent = { scheduled_time?: string };

type Outcome = "sent" | "empty" | "failed" | "unknown" | "handled";

/** The Toronto day the schedule fired for; a retry carries the original time. */
export function runDateOf(event: NudgeEvent | undefined, now = new Date()): string {
  const at = event?.scheduled_time ? new Date(event.scheduled_time) : now;
  return todayToronto(Number.isNaN(at.getTime()) ? now : at);
}

async function runFor(botToken: string, chatId: number, runDate: string): Promise<Outcome> {
  if (!(await claimRun(runDate, chatId))) return "handled";
  let digest;
  try {
    digest = await loadDigest(chatId, runDate);
  } catch (err) {
    // Nothing was sent, so the retry may claim it again.
    await finishRun(runDate, chatId, { status: "failed" });
    throw err;
  }
  if (!digest) {
    await finishRun(runDate, chatId, { status: "empty" });
    return "empty";
  }
  let messageId: number | undefined;
  try {
    messageId = await sendMessage(botToken, chatId, digest.text, { inline_keyboard: digest.keyboard }, {
      html: true,
      silent: !digest.ring,
    });
  } catch (err) {
    if (err instanceof TelegramError) {
      await finishRun(runDate, chatId, { status: "failed" });
      console.error("nudge send refused", err.message);
      return "failed";
    }
    console.error("nudge send outcome unknown", err);
    return "unknown";
  }
  if (messageId === undefined) return "unknown";
  await finishRun(runDate, chatId, { status: "sent", messageId });
  return "sent";
}

export async function handler(event?: NudgeEvent): Promise<{ runDate: string; outcomes: Outcome[] }> {
  const { botToken, allowedChatIds } = await getNudgeConfig();
  const runDate = runDateOf(event);
  const outcomes: Outcome[] = [];
  for (const chatId of allowedChatIds) outcomes.push(await runFor(botToken, chatId, runDate));
  console.log(JSON.stringify({ msg: "nudge", runDate, outcomes }));
  // After every chat had its turn: the retry reclaims only the refused ones.
  const refused = outcomes.filter((o) => o === "failed").length;
  if (refused > 0) throw new Error(`nudge: Telegram refused ${refused} digest(s)`);
  return { runDate, outcomes };
}
