/**
 * The /recurring menu: screens over the recurring series, edited in place by
 * their buttons (design §E). Stateless: a screen's subject is in its button
 * data (series id, transaction id, date), and anything ticked lives in the
 * message's own keyboard, as on the mention review. Every screen is rendered
 * from the database on each tap, so a stale screen shows current state the
 * next time it is touched.
 *
 * Callback data, all `r:`-prefixed and at most 44 bytes:
 * `r:l:<offset>` list · `r:v:<sid>` detail.
 */
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
import { loadBook, type Book, type BookRow, type BookSeries } from "./recurring-db.js";
import { answerCallbackQuery, editMessageText, esc, sendMessage } from "./telegram.js";

export type Screen = { text: string; keyboard: Keyboard };

export type RecurringTap = { op: "list"; offset: number } | { op: "view"; sid: number };

const SID = "(\\d{1,10})";

const TAPS: [RegExp, (m: RegExpExecArray) => RecurringTap][] = [
  [/^r:l:(\d{1,4})$/, (m) => ({ op: "list", offset: Number(m[1]) })],
  [new RegExp(`^r:v:${SID}$`), (m) => ({ op: "view", sid: Number(m[1]) })],
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
  if (v.pausedNow) lines.push(capitalise(pauseText(v.pausedNow)));
  return { text: lines.join("\n"), keyboard: [BACK_TO_LIST] };
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

/** What a tap does: a screen to edit in, and the pop-up. */
type Outcome = { screen?: Screen; ack?: string };

async function respond(tap: RecurringTap, ctx: TapContext): Promise<Outcome> {
  const book = await loadBook();
  switch (tap.op) {
    case "list":
      return { screen: listScreen(book, ctx.today, tap.offset) };
    case "view":
      return { screen: detailScreen(book, tap.sid, ctx.today) };
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
  await answerCallbackQuery(ctx.botToken, ctx.callbackId, outcome.ack);
}
