/**
 * The scheduled nudge function, `finflow-nudge` (design §F): at 09:00 Toronto
 * it sends each allowlisted chat the day's recurring digest, at most once.
 * No Gemini, no S3, no Function URL; taps on the digest's buttons reach the
 * webhook like any other button.
 *
 * Delivery is at-least-once, so each chat's run is claimed in `nudge_runs`
 * before the send. The Scheduler invokes the function asynchronously: its
 * retry policy covers an invocation it could not deliver, and a function
 * error is retried by Lambda's asynchronous retries (two by default), with
 * the same scheduled time.
 *
 * - claimed, then sent → 'sent' with its message id;
 * - nothing to say → 'empty', no message;
 * - Telegram answered with an error, or the digest could not be built →
 *   'failed', and once every chat had its turn the function throws, so a
 *   retry claims it again (at most three attempts);
 * - no answer (timeout, reset) → left 'claimed' and not retried: the digest
 *   may have arrived, and a lost day costs less than a duplicate.
 *
 * Recording 'failed' is best effort: with the database gone it stays
 * 'claimed', and that day is lost like an unanswered send.
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

/** Nothing was sent: 'failed', so a retry claims the run again. */
async function failRun(runDate: string, chatId: number): Promise<"failed"> {
  await finishRun(runDate, chatId, { status: "failed" }).catch((err) => console.error("nudge failure not recorded", err));
  return "failed";
}

async function runFor(botToken: string, chatId: number, runDate: string): Promise<Outcome> {
  if (!(await claimRun(runDate, chatId))) return "handled";
  let digest;
  try {
    digest = await loadDigest(chatId, runDate);
    if (!digest) {
      await finishRun(runDate, chatId, { status: "empty" });
      return "empty";
    }
  } catch (err) {
    console.error("nudge digest not built", err);
    return failRun(runDate, chatId);
  }
  let messageId: number | undefined;
  try {
    messageId = await sendMessage(botToken, chatId, digest.text, { inline_keyboard: digest.keyboard }, {
      html: true,
      silent: !digest.ring,
    });
  } catch (err) {
    if (err instanceof TelegramError) {
      console.error("nudge send refused", err.message);
      return failRun(runDate, chatId);
    }
    console.error("nudge send outcome unknown", err);
    return "unknown";
  }
  if (messageId === undefined) return "unknown";
  try {
    await finishRun(runDate, chatId, { status: "sent", messageId });
  } catch (err) {
    // Sent, but its message id is not recorded: the run stays 'claimed' (never
    // sent again), and that digest's buttons answer "no longer current" all day.
    console.error("nudge sent but not recorded", err);
    return "unknown";
  }
  return "sent";
}

export async function handler(event?: NudgeEvent): Promise<{ runDate: string; outcomes: Outcome[] }> {
  const { botToken, allowedChatIds } = await getNudgeConfig();
  const runDate = runDateOf(event);
  const outcomes: Outcome[] = [];
  for (const chatId of allowedChatIds) {
    try {
      outcomes.push(await runFor(botToken, chatId, runDate));
    } catch (err) {
      // The claim itself failed: nothing is claimed, so a retry tries this chat again.
      console.error("nudge run not claimed", err);
      outcomes.push("failed");
    }
  }
  console.log(JSON.stringify({ msg: "nudge", runDate, outcomes }));
  // After every chat had its turn: a retry claims only the failed ones again.
  const failed = outcomes.filter((o) => o === "failed").length;
  if (failed > 0) throw new Error(`nudge: ${failed} digest(s) failed`);
  return { runDate, outcomes };
}
