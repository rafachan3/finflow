/**
 * The /recurring menu: screens over the recurring series, edited in place by
 * their buttons (design §E). Stateless: a screen's subject is in its button
 * data (series id, transaction id, date), and anything ticked lives in the
 * message's own keyboard, as on the mention review. Every screen is rendered
 * from the database on each tap, so a stale screen shows current state the
 * next time it is touched.
 *
 * Callback data, all `r:`-prefixed and at most 44 bytes:
 * `r:l:<offset>` list · `r:v:<sid>` detail ·
 * `r:p:<sid>` → `r:pf:<sid>:<from>` → `r:pu:<sid>:<from>:<until|0>` pause
 * (only the last writes) · `r:u:<sid>:<date>` resume · `r:n:<sid>` rename
 * (a ForceReply prompt; the reply is routed by its `#<sid>`) · `r:pd:<sid>:<from>`
 * asks for a typed pause end the same way ·
 * `r:x:<sid>` / `r:xy:<sid>` delete, asked then done. Dates are yyyymmdd.
 */
import { collapseSpaces } from "./commands.js";
import { parseDateReply } from "./extraction.js";
import type { Keyboard } from "./mentions.js";
import {
  amountBand,
  dayNumber,
  occurrences,
  type Band,
  type Cadence,
  type Fit,
  type Pause,
  type Slot,
} from "./recurring.js";
import {
  deleteSeries,
  loadBook,
  pauseSeries,
  renameSeries,
  resumeSeries,
  type Book,
  type BookRow,
  type BookSeries,
} from "./recurring-db.js";
import { answerCallbackQuery, editMessageText, esc, sendMessage } from "./telegram.js";

export type Screen = { text: string; keyboard: Keyboard };

export type RecurringTap =
  | { op: "list"; offset: number }
  | { op: "view" | "pause" | "rename" | "askDelete" | "delete"; sid: number }
  | { op: "pauseFrom" | "pauseDate"; sid: number; from: string }
  | { op: "pauseUntil"; sid: number; from: string; until: string | null }
  | { op: "resume"; sid: number; on: string };

const SID = "(\\d{1,10})";
const DATE = "(\\d{8})";

/** yyyymmdd → YYYY-MM-DD. */
function iso(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
}

/** YYYY-MM-DD → yyyymmdd, for callback data. */
function compact(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

const TAPS: [RegExp, (m: RegExpExecArray) => RecurringTap][] = [
  [/^r:l:(\d{1,4})$/, (m) => ({ op: "list", offset: Number(m[1]) })],
  [new RegExp(`^r:v:${SID}$`), (m) => ({ op: "view", sid: Number(m[1]) })],
  [new RegExp(`^r:p:${SID}$`), (m) => ({ op: "pause", sid: Number(m[1]) })],
  [new RegExp(`^r:pf:${SID}:${DATE}$`), (m) => ({ op: "pauseFrom", sid: Number(m[1]), from: iso(m[2]) })],
  [
    new RegExp(`^r:pu:${SID}:${DATE}:(\\d{8}|0)$`),
    (m) => ({ op: "pauseUntil", sid: Number(m[1]), from: iso(m[2]), until: m[3] === "0" ? null : iso(m[3]) }),
  ],
  [new RegExp(`^r:pd:${SID}:${DATE}$`), (m) => ({ op: "pauseDate", sid: Number(m[1]), from: iso(m[2]) })],
  [new RegExp(`^r:u:${SID}:${DATE}$`), (m) => ({ op: "resume", sid: Number(m[1]), on: iso(m[2]) })],
  [new RegExp(`^r:n:${SID}$`), (m) => ({ op: "rename", sid: Number(m[1]) })],
  [new RegExp(`^r:x:${SID}$`), (m) => ({ op: "askDelete", sid: Number(m[1]) })],
  [new RegExp(`^r:xy:${SID}$`), (m) => ({ op: "delete", sid: Number(m[1]) })],
];

/** A /recurring button's action, or null for any other callback data. */
export function parseRecurringTap(data: string | undefined): RecurringTap | null {
  for (const [pattern, make] of TAPS) {
    const m = pattern.exec(data ?? "");
    if (m) return make(m);
  }
  return null;
}

// ---- Formatting -----------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Oct 15`. */
export function day(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** `Nov 13–17`, or `Oct 30–Nov 2` across a month. */
export function range(from: string, to: string): string {
  return from.slice(0, 7) === to.slice(0, 7) ? `${day(from)}–${Number(to.slice(8))}` : `${day(from)}–${day(to)}`;
}

/** Cents as `2,000.00`, by string arithmetic. */
export function money(cents: number): string {
  const digits = String(Math.abs(cents)).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+$)/g, ",");
  return `${cents < 0 ? "−" : ""}${whole}.${digits.slice(-2)}`;
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function dayAnchor(a: number): string {
  return a > 0 ? `the ${ordinal(a)}` : `the ${["", "second-", "third-", "fourth-"][-a - 1]}last day`;
}

const CADENCE_NAMES: Record<Cadence, string> = {
  weekly: "weekly",
  biweekly: "every 2 weeks",
  semimonthly: "twice a month",
  monthly: "monthly",
  quarterly: "quarterly",
  yearly: "yearly",
};

/** `monthly, around the 15th`; the bare cadence when nothing is linked to fit. */
export function cadenceText(cadence: Cadence, fit: Fit | null): string {
  const name = CADENCE_NAMES[cadence];
  if (!fit) return name;
  const a = fit.anchor;
  if ("phase" in a) return `${name}, ${WEEKDAYS[new Date(a.phase * 86_400_000).getUTCDay()]}`;
  if (a.days.length === 2) return `${name}, ${dayAnchor(a.days[0])} and ${dayAnchor(a.days[1])}`;
  if (cadence === "yearly") return `${name}, in ${MONTHS[a.months[0]]}, around ${dayAnchor(a.days[0])}`;
  return `${name}, around ${dayAnchor(a.days[0])}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// ---- What a series looks like today ----------------------------------------

interface SeriesView {
  series: BookSeries;
  /** Its payments, oldest first. */
  linked: BookRow[];
  fit: Fit | null;
  slots: Slot[];
  band: Band | null;
  /** The pause covering today, if any. */
  pausedNow: Pause | null;
  missed: Slot[];
  /** The next expected payment that is due or upcoming. */
  next: Slot | null;
}

function viewOf(book: Book, series: BookSeries, today: string): SeriesView {
  const linked = book.rows.filter((r) => r.seriesId === series.id);
  const pauses = book.pauses.get(series.id) ?? [];
  const { fit, slots } = occurrences({
    cadence: series.cadence,
    payments: linked.map((r) => ({ id: r.id, date: r.date })),
    skips: book.skips.get(series.id) ?? [],
    pauses,
    today,
  });
  const t = dayNumber(today);
  return {
    series,
    linked,
    fit,
    slots,
    band: amountBand(linked.map((r) => r.amount), series.amountVaries),
    pausedNow:
      pauses.find((p) => dayNumber(p.from) <= t && (p.until === null || t < dayNumber(p.until))) ?? null,
    missed: slots.filter((s) => s.status === "missed"),
    next: slots.find((s) => s.status === "due" || s.status === "upcoming") ?? null,
  };
}

function pauseText(p: Pause): string {
  return `⏸ paused since ${day(p.from)}${p.until ? `, resumes ${day(p.until)}` : ""}`;
}

/** One list line's state: paused, or cadence, usual amount and what is next. */
function summary(v: SeriesView): string {
  if (v.pausedNow) return pauseText(v.pausedNow);
  const parts = [cadenceText(v.series.cadence, v.fit)];
  if (v.band) parts.push(`~${money(v.band.typical)}`);
  else if (v.series.amountVaries) parts.push("varies");
  if (v.linked.length === 0) parts.push("no payments linked");
  else if (v.missed.length > 0) parts.push(`${v.missed.length} not logged`);
  else if (v.next) parts.push(`next ${range(v.next.start, v.next.end)}`);
  return parts.join(" · ");
}

// ---- Screens ----------------------------------------------------------------

const LIST_PAGE = 16;
const KINDS = [
  ["expense", "Expenses"],
  ["income", "Income"],
  ["transfer", "Transfers"],
] as const;

const BACK_TO_LIST = [{ text: "‹ All recurring", callback_data: "r:l:0" }];
const GONE: Screen = { text: "That series no longer exists.", keyboard: [BACK_TO_LIST] };

/** The series, grouped by kind, 16 to a page, with a button each. */
export function listScreen(book: Book, today: string, offset = 0): Screen {
  const sorted = KINDS.flatMap(([kind]) => book.series.filter((s) => s.kind === kind));
  const page = sorted.slice(offset, offset + LIST_PAGE);
  const lines = [`<b>↻ Recurring · ${book.series.length} tracked</b>`];
  if (book.series.length === 0) lines.push("Nothing tracked yet.");
  for (const [kind, heading] of KINDS) {
    const views = page.filter((s) => s.kind === kind).map((s) => viewOf(book, s, today));
    if (views.length === 0) continue;
    lines.push(`<b>${heading}</b>`);
    for (const v of views) lines.push(`• ${esc(v.series.name)} — ${summary(v)}`);
  }
  const keyboard: Keyboard = [];
  for (let i = 0; i < page.length; i += 2) {
    keyboard.push(
      page.slice(i, i + 2).map((s) => {
        const paused = viewOf(book, s, today).pausedNow ? " ⏸" : "";
        return { text: `${cut(s.name, 30)}${paused}`, callback_data: `r:v:${s.id}` };
      }),
    );
  }
  if (sorted.length > offset + LIST_PAGE) {
    keyboard.push([{ text: "More ›", callback_data: `r:l:${offset + LIST_PAGE}` }]);
  }
  return { text: lines.join("\n"), keyboard };
}

function keysText(s: BookSeries): string {
  if (s.kind === "income") return `income · ${esc(s.source ?? "")}`;
  if (s.kind === "transfer") return `transfer · ${esc(s.fromAccount ?? "Chequing")} → ${esc(s.toAccount ?? "Chequing")}`;
  return s.subcategory ? `expense · ${esc(s.subcategory)}` : "expense";
}

/** One series: cadence, usual amount, history, what is next, and its management buttons. */
export function detailScreen(book: Book, sid: number, today: string): Screen {
  const series = book.series.find((s) => s.id === sid);
  if (!series) return GONE;
  const v = viewOf(book, series, today);
  const lines = [`<b>↻ ${esc(series.name)}</b> — ${keysText(series)}`, capitalise(cadenceText(series.cadence, v.fit))];
  if (v.band) lines.push(`Usually ${money(v.band.typical)} (${money(v.band.low)}–${money(v.band.high)})`);
  else if (series.amountVaries) lines.push("Amount varies");
  if (v.linked.length === 0) {
    lines.push("No payments linked yet.");
  } else {
    const n = v.linked.length;
    lines.push(`${n} payment${n === 1 ? "" : "s"} since ${day(v.linked[0].date)} · last ${day(v.linked[n - 1].date)}`);
    const missed = v.missed.map((s) => day(s.due));
    const notLogged =
      missed.length === 0 ? "none" : missed.length <= 3 ? missed.join(", ") : `${missed.slice(0, 3).join(", ")} +${missed.length - 3} more`;
    lines.push(`${v.next ? `Next: ${range(v.next.start, v.next.end)} · ` : ""}not logged: ${notLogged}`);
  }
  let manage: Keyboard[number] = [{ text: "⏸ Pause", callback_data: `r:p:${sid}` }];
  if (v.pausedNow) {
    lines.push(pauseText(v.pausedNow));
    manage = [{ text: "▶️ Resume today", callback_data: `r:u:${sid}:${compact(today)}` }];
    // A payment logged during the pause says the series came back then.
    const back = v.linked.find((r) => r.date >= v.pausedNow!.from && r.date < today);
    if (back) {
      lines.push(`Logged while paused: ${day(back.date)}. Resume from then?`);
      manage.push({ text: `▶️ Resume from ${day(back.date)}`, callback_data: `r:u:${sid}:${compact(back.date)}` });
    }
  }
  return {
    text: lines.join("\n"),
    keyboard: [
      [...manage, { text: "✏️ Rename", callback_data: `r:n:${sid}` }],
      [{ text: "🗑 Delete", callback_data: `r:x:${sid}` }],
      BACK_TO_LIST,
    ],
  };
}

/** The same day n months on, clamped to that month's length. */
function addMonths(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

/** Pause, step 1: from today, or from the first payment not logged. Writes nothing. */
export function pauseFromScreen(book: Book, sid: number, today: string): Screen {
  const series = book.series.find((s) => s.id === sid);
  if (!series) return GONE;
  const first = viewOf(book, series, today).missed[0];
  const options = [{ text: `Today, ${day(today)}`, callback_data: `r:pf:${sid}:${compact(today)}` }];
  if (first && first.due !== today) {
    options.push({ text: `From ${day(first.due)}, first not logged`, callback_data: `r:pf:${sid}:${compact(first.due)}` });
  }
  return {
    text: `<b>⏸ Pause ${esc(series.name)}</b>\nFrom when? A payment expected from that day on is not counted as not logged.`,
    keyboard: [...options.map((o) => [o]), [{ text: "Cancel", callback_data: `r:v:${sid}` }]],
  };
}

/** Pause, step 2: until resumed, or until a date one or three months on. The tap writes. */
export function pauseUntilScreen(book: Book, sid: number, from: string, today: string): Screen {
  const series = book.series.find((s) => s.id === sid);
  if (!series) return GONE;
  const until = (d: string | null) => `r:pu:${sid}:${compact(from)}:${d ? compact(d) : "0"}`;
  const later = [addMonths(today, 1), addMonths(today, 3)];
  return {
    text: `<b>⏸ Pause ${esc(series.name)} from ${day(from)}</b>\nUntil when?`,
    keyboard: [
      [{ text: "Until I resume", callback_data: until(null) }],
      later.map((d) => ({ text: `Until ${day(d)}`, callback_data: until(d) })),
      [{ text: "Until a date I type…", callback_data: `r:pd:${sid}:${compact(from)}` }],
      [{ text: "Cancel", callback_data: `r:v:${sid}` }],
    ],
  };
}

function payments(n: number): string {
  return `${n} payment${n === 1 ? "" : "s"}`;
}

/** Delete, asked first: the payments stay, unlinked. */
export function deleteAskScreen(book: Book, sid: number): Screen {
  const series = book.series.find((s) => s.id === sid);
  if (!series) return GONE;
  const n = book.rows.filter((r) => r.seriesId === sid).length;
  return {
    text: `<b>🗑 Delete ${esc(series.name)}?</b>\nIts ${payments(n)} stay saved and are no longer marked recurring.`,
    keyboard: [
      [
        { text: "🗑 Delete", callback_data: `r:xy:${sid}` },
        { text: "Cancel", callback_data: `r:v:${sid}` },
      ],
    ],
  };
}

// ---- Telegram ---------------------------------------------------------------

/** `/recurring`: the list as a new message. */
export async function sendRecurringList(botToken: string, chatId: number, today: string): Promise<void> {
  const { text, keyboard } = listScreen(await loadBook(), today);
  await sendMessage(botToken, chatId, text, { inline_keyboard: keyboard }, { html: true });
}

export type TapContext = {
  botToken: string;
  chatId: number;
  callbackId: string;
  messageId: number;
  /** The keyboard as Telegram sent it back with the tap. */
  keyboard: Keyboard;
  today: string;
};

/**
 * What a tap does: a screen to edit in, a new message to send (the rename
 * prompt), and the pop-up. A write that finds its work already done (a
 * double tap, a Telegram retry) only pops up, so it never redraws over the
 * screen the first tap left.
 */
type Outcome = { screen?: Screen; prompt?: string; ack?: string };

const RENAME = /^Rename #(\d{1,10}) /;
const PAUSE_PROMPT = /^Pause #(\d{1,10}) from (\d{4}-\d{2}-\d{2}) /;
const NAME_MAX = 60;

async function respond(tap: RecurringTap, ctx: TapContext): Promise<Outcome> {
  const detail = async (sid: number) => detailScreen(await loadBook(), sid, ctx.today);
  switch (tap.op) {
    case "list":
      return { screen: listScreen(await loadBook(), ctx.today, tap.offset) };
    case "view":
      return { screen: await detail(tap.sid) };
    case "pause":
      return { screen: pauseFromScreen(await loadBook(), tap.sid, ctx.today) };
    case "pauseFrom":
      return { screen: pauseUntilScreen(await loadBook(), tap.sid, tap.from, ctx.today) };
    case "pauseUntil": {
      const result = await pauseSeries(tap.sid, tap.from, tap.until);
      if (result === "already") return { ack: "Already paused." };
      if (result === "missing") return { screen: GONE };
      const ack = result === "overlap" ? "Overlaps an earlier pause. Nothing changed." : `Paused from ${day(tap.from)}.`;
      return { screen: await detail(tap.sid), ack };
    }
    case "resume":
      return (await resumeSeries(tap.sid, tap.on)) ? { screen: await detail(tap.sid), ack: "Resumed." } : { ack: "Not paused." };
    case "rename": {
      const series = (await loadBook()).series.find((s) => s.id === tap.sid);
      if (!series) return { screen: GONE };
      return { prompt: `Rename #${series.id} (${series.name}): reply with the new name.`, ack: "Reply with the new name." };
    }
    case "pauseDate": {
      const series = (await loadBook()).series.find((s) => s.id === tap.sid);
      if (!series) return { screen: GONE };
      return {
        prompt: `Pause #${series.id} from ${tap.from} (${series.name}): reply with the day payments start again, e.g. Dec 15.`,
        ack: "Reply with the date.",
      };
    }
    case "askDelete":
      return { screen: deleteAskScreen(await loadBook(), tap.sid) };
    case "delete": {
      const deleted = await deleteSeries(tap.sid);
      if (!deleted) return { ack: "Already deleted." };
      return {
        screen: {
          text: `Deleted ${esc(deleted.name)}. Its ${payments(deleted.unlinked)} are no longer marked recurring.`,
          keyboard: [BACK_TO_LIST],
        },
        ack: "Deleted.",
      };
    }
  }
}

/**
 * A tap on a /recurring button. The message is edited first and the tap
 * answered after, so the button's spinner holds until the screen changes.
 */
export async function handleRecurringTap(tap: RecurringTap, ctx: TapContext): Promise<void> {
  const outcome = await respond(tap, ctx);
  if (outcome.screen) {
    const { text, keyboard } = outcome.screen;
    await editMessageText(ctx.botToken, ctx.chatId, ctx.messageId, text, keyboard, { html: true });
  }
  if (outcome.prompt) {
    await sendMessage(ctx.botToken, ctx.chatId, outcome.prompt, {
      force_reply: true,
      input_field_placeholder: tap.op === "rename" ? "New name" : "Dec 15",
    });
  }
  await answerCallbackQuery(ctx.botToken, ctx.callbackId, outcome.ack);
}

async function renameReply(sid: number, text: string): Promise<string> {
  const name = collapseSpaces(text);
  if (name === "" || name.length > NAME_MAX) return `A name is 1 to ${NAME_MAX} characters. Tap ✏️ Rename to try again.`;
  const result = await renameSeries(sid, name);
  if (result === "renamed") return `Renamed to ${name}.`;
  return result === "taken" ? `Another series is already called ${name}. Pick another name.` : "That series no longer exists.";
}

/**
 * The day a pause ends, typed: a date with no year that would fall on or
 * before the pause's start means next year's. Also how a series that starts
 * billing later (a free trial) is told not to expect a payment before then.
 */
async function pauseReply(sid: number, from: string, text: string, today: string): Promise<string> {
  let until = parseDateReply(text, today);
  if (until !== null && until <= from && !/\d{4}/.test(text)) until = addMonths(until, 12);
  if (until === null || until <= from) {
    return `Send a date after ${day(from)}, like Dec 15 or 2027-01-15. Tap ⏸ Pause to try again.`;
  }
  const result = await pauseSeries(sid, from, until);
  if (result === "missing") return "That series no longer exists.";
  if (result === "overlap") return "That overlaps an earlier pause. Nothing changed.";
  return `Paused from ${day(from)} until ${day(until)}.`;
}

/**
 * A reply to one of the menu's prompts (rename, or a pause's end date) acts
 * on that series; false for any other message. The prompt's own text
 * carries the series id and date, so no waiting state is stored.
 */
export async function answerPrompt(
  message: { text?: string; reply_to_message?: { text?: string } },
  chatId: number,
  botToken: string,
  today: string,
): Promise<boolean> {
  const prompt = message.reply_to_message?.text ?? "";
  const rename = RENAME.exec(prompt);
  const pause = PAUSE_PROMPT.exec(prompt);
  if (!rename && !pause) return false;
  const text = message.text ?? "";
  const reply = rename
    ? await renameReply(Number(rename[1]), text)
    : await pauseReply(Number(pause![1]), pause![2], text, today);
  await sendMessage(botToken, chatId, reply);
  return true;
}
