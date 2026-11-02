/**
 * The daily digest (design §E.3): one HTML message over every series, in
 * order of urgency for the reader. Due now (the window is open), Coming up
 * (a window opens within 7 days), Not logged (past its window and grace),
 * then what is left to review. `renderDigest` is pure; `loadDigest` reads
 * what it needs for one chat and day.
 *
 * It rings only when something became new that day: a payment turned not
 * logged, or a fixed-amount expense's window opened. Income and an amount
 * that varies (interest) are listed silently until they are not logged.
 * A series whose amount varies never shows an amount: "log it when it posts".
 */
import type { Keyboard } from "./mentions.js";
import { dayNumber, halfPeriod, isoDate, proposeSeries, type Kind, type Slot } from "./recurring.js";
import { loadBook, missedRun, runDay, skipSlot, skipsSince, unskipSlot, type Book } from "./recurring-db.js";
import {
  candidates,
  cut,
  day,
  dayIn,
  money,
  range,
  recount,
  toggleLabel,
  toReview,
  viewOf,
  WEEKDAYS,
  type Screen,
  type SeriesView,
  type TapContext,
} from "./recurring-menu.js";
import { answerCallbackQuery, editMessageText, esc } from "./telegram.js";

export interface Digest {
  text: string;
  keyboard: Keyboard;
  /** False: send with disable_notification. */
  ring: boolean;
}

export interface DigestInput {
  book: Book;
  /** The digest's day, Toronto. */
  today: string;
  /** Skips recorded on or after that day: shown as skipped, with Undo. */
  skipped?: { seriesId: number; due: string }[];
  /** A day with no digest, noted in the footer. */
  noDigestOn?: string | null;
}

/** Not-logged rows shown before the rest folds into an expandable quote. */
const NOT_LOGGED_SHOWN = 10;
/** Item rows of buttons; review, suggestions and the menu come after. */
const BUTTON_ROWS = 6;
/** Below Telegram's 4096, counted as the reader sees it. */
const VISIBLE_MAX = 3500;
const ICON: Record<Kind, string> = { income: "💰", expense: "💳", transfer: "🔁" };

/** A slot in the digest; `skipped` is the stored skip date when it shows as skipped. */
type Item = { view: SeriesView; slot: Slot; skipped: string | null };

function name(item: Item): string {
  return esc(item.view.series.name);
}

function amount(view: SeriesView): string {
  if (view.series.amountVaries) return "amount varies";
  return view.band ? `~${money(view.band.typical)}` : "";
}

function dueLine(item: Item, today: string): string {
  const { view, slot } = item;
  if (item.skipped) return `✓ <b>${name(item)}</b> · ${dayIn(slot.due, today)} skipped`;
  const head = `${ICON[view.series.kind]} <b>${name(item)}</b>`;
  if (view.series.amountVaries) return `${head} — amount varies, log it when it posts (by ${day(slot.end)})`;
  const usual = amount(view);
  return `${head} — ${usual ? `${usual}, ` : ""}${range(slot.start, slot.end)}`;
}

function comingLine(item: Item): string {
  const usual = amount(item.view);
  return `${range(item.slot.start, item.slot.end)}  ${name(item)}${usual ? ` — ${usual}` : ""}`;
}

function missedLine(item: Item, today: string): string {
  if (item.skipped) return `✓ <b>${name(item)}</b> · ${dayIn(item.slot.due, today)} skipped`;
  return `⚠️ <b>${name(item)}</b> — around ${dayIn(item.slot.due, today)}, nothing logged by ${dayIn(item.slot.lastDay, today)}`;
}

/** What the reader sees of Telegram HTML: tags dropped, entities read. */
function visible(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function compact(iso: string): string {
  return iso.replace(/-/g, "");
}

/** A digest row's buttons: Find and Skip, ⏸ on a not-logged one; Undo once skipped. */
function itemButtons(item: Item, label: string): Keyboard[number] {
  const sid = item.view.series.id;
  const at = `${sid}:${compact(item.slot.due)}`;
  if (item.skipped) return [{ text: `↩ Undo skip: ${label}`, callback_data: `r:du:${sid}:${compact(item.skipped)}` }];
  const row = [
    { text: `🔍 ${label}: logged?`, callback_data: `r:df:${at}` },
    { text: "⏭ Skip", callback_data: `r:dk:${at}` },
  ];
  if (item.slot.status === "missed") row.push({ text: "⏸", callback_data: `r:p:${sid}` });
  return row;
}

/**
 * The digest for a day, or null when it has nothing to say. Up to 10
 * not-logged rows, the rest in an expandable quote cut to fit the message.
 */
export function renderDigest(input: DigestInput): Digest | null {
  const { book, today } = input;
  const t = dayNumber(today);
  const skipped = input.skipped ?? [];
  const due: Item[] = [];
  const coming: Item[] = [];
  const missed: Item[] = [];
  for (const series of book.series) {
    const view = viewOf(book, series, today);
    for (const slot of view.slots) {
      const shownSkip =
        slot.status === "skipped"
          ? (skipped.find(
              (s) => s.seriesId === series.id && Math.abs(dayNumber(s.due) - dayNumber(slot.due)) <= halfPeriod(series.cadence),
            )?.due ?? null)
          : null;
      const item = { view, slot, skipped: shownSkip };
      if (slot.status === "due" || (shownSkip && t <= dayNumber(slot.lastDay))) due.push(item);
      else if (slot.status === "missed" || shownSkip) missed.push(item);
      else if (slot.status === "upcoming" && dayNumber(slot.start) <= t + 7) coming.push(item);
    }
  }
  const byStart = (a: Item, b: Item) =>
    a.slot.start.localeCompare(b.slot.start) || a.view.series.name.localeCompare(b.view.series.name);
  due.sort(byStart);
  coming.sort(byStart);
  // Newest first: the gap the owner most likely remembers.
  missed.sort((a, b) => b.slot.due.localeCompare(a.slot.due) || a.view.series.name.localeCompare(b.view.series.name));

  const reviewing = book.series
    .map((s) => ({ s, n: candidates(book, s).length }))
    .filter((r) => r.n > 0);
  const review = toReview(book).size;
  const suggestions = proposeSeries(book.rows, book.dismissed, today).length;
  if (due.length + coming.length + missed.length + review + suggestions === 0) return null;

  const ring =
    missed.some((i) => !i.skipped && dayNumber(i.slot.lastDay) + 1 === t) ||
    due.some(
      (i) => !i.skipped && i.slot.start === today && i.view.series.kind === "expense" && !i.view.series.amountVaries,
    );

  const head = `<b>↻ Recurring · ${WEEKDAYS[new Date(t * 86_400_000).getUTCDay()]} ${day(today)}</b>`;
  const counts = [
    review === 0
      ? ""
      : reviewing.length === 1
        ? `🧹 ${reviewing[0].n} past payment${reviewing[0].n === 1 ? " looks" : "s look"} like ${esc(reviewing[0].s.name)}`
        : `🧹 ${review} past payments to review`,
    suggestions === 0 ? "" : `🔎 ${suggestions} possible new recurring item${suggestions === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const footer = input.noDigestOn ? `⚠️ No digest on ${dayIn(input.noDigestOn, today)}` : "";

  const missedLines = missed.map((i) => missedLine(i, today));
  const shown = missedLines.slice(0, NOT_LOGGED_SHOWN);
  const folded = missedLines.slice(NOT_LOGGED_SHOWN);
  const notLogged = missed.filter((i) => !i.skipped).length;
  const compose = (rest: string[], more: number) =>
    [
      head,
      due.length ? `<b>Due now</b>\n${due.map((i) => dueLine(i, today)).join("\n")}` : "",
      coming.length ? `<b>Coming up (7 days)</b>\n<blockquote>${coming.map(comingLine).join("\n")}</blockquote>` : "",
      missed.length
        ? [
            `<b>Not logged · ${notLogged}</b>`,
            ...shown,
            ...(rest.length ? [`<blockquote expandable>${rest.join("\n")}</blockquote>`] : []),
            ...(more ? [`+${more} more in /recurring`] : []),
          ].join("\n")
        : "",
      counts.join("\n"),
      footer,
    ]
      .filter(Boolean)
      .join("\n\n");
  let rest = folded;
  let text = compose(rest, 0);
  while (rest.length > 0 && visible(text).length > VISIBLE_MAX) {
    rest = rest.slice(0, -1);
    text = compose(rest, folded.length - rest.length);
  }

  // One row per item the owner can act on, due first, names in the buttons.
  const items = [...due, ...missed];
  const perSeries = new Map<number, number>();
  for (const i of items) perSeries.set(i.view.series.id, (perSeries.get(i.view.series.id) ?? 0) + 1);
  const keyboard: Keyboard = items.slice(0, BUTTON_ROWS).map((i) => {
    const twice = (perSeries.get(i.view.series.id) ?? 0) > 1;
    return itemButtons(i, `${cut(i.view.series.name, 18)}${twice ? ` ${day(i.slot.due)}` : ""}`);
  });
  const todo = [
    ...(review > 0 ? [{ text: `🧹 Review (${review})`, callback_data: "r:b" }] : []),
    ...(suggestions > 0 ? [{ text: `🔎 Suggestions (${suggestions})`, callback_data: "r:sg" }] : []),
  ];
  if (todo.length) keyboard.push(todo);
  keyboard.push([{ text: "↻ All recurring", callback_data: "r:l:0" }]);
  return { text, keyboard, ring };
}

/** The digest of a chat for a day, from the database as it is now. */
export async function loadDigest(chatId: number, day: string): Promise<Digest | null> {
  const book = await loadBook();
  return renderDigest({ book, today: day, skipped: await skipsSince(day), noDigestOn: await missedRun(day, chatId) });
}

// ---- Taps on the digest's buttons (they arrive at the webhook) -----------------

/**
 * `r:df:<sid>:<yyyymmdd>` find, `r:dk:…` skip, `r:du:…` undo a skip, `r:dv`
 * back to the digest. The date is the expected payment's (or, for undo, the
 * stored skip's).
 */
export type DigestTap = { op: "find" | "skip" | "unskip"; sid: number; due: string } | { op: "back" };

const OPS = { f: "find", k: "skip", u: "unskip" } as const;

export function parseDigestTap(data: string | undefined): DigestTap | null {
  if (data === "r:dv") return { op: "back" };
  const m = /^r:d([fku]):(\d{1,10}):(\d{4})(\d{2})(\d{2})$/.exec(data ?? "");
  if (!m) return null;
  const due = `${m[3]}-${m[4]}-${m[5]}`;
  // Only a real calendar day: callback data comes from the client.
  if (isoDate(dayNumber(due)) !== due) return null;
  return { op: OPS[m[1] as keyof typeof OPS], sid: Number(m[2]), due };
}

const BACK = [{ text: "‹ Back to digest", callback_data: "r:dv" }];

/**
 * Find: the unlinked payments that look like the series within half a period
 * of that date, as the review's toggles (Apply links the ticked and leaves
 * the rest out of the series). With none, how to log it: the usual message,
 * whose card offers the link. Writes nothing.
 */
export function findScreen(book: Book, sid: number, due: string, today: string): Screen {
  const series = book.series.find((s) => s.id === sid);
  if (!series) return { text: "That series no longer exists.", keyboard: [BACK] };
  const near = candidates(book, series).filter(
    (c) => Math.abs(dayNumber(c.row.date) - dayNumber(due)) <= halfPeriod(series.cadence),
  );
  const when = dayIn(due, today);
  if (near.length === 0) {
    const band = viewOf(book, series, today).band;
    const example = [series.name.toLowerCase(), band ? money(band.typical) : "", day(due)].filter(Boolean).join(" ");
    return {
      text: `Nothing logged around ${when}. Send it as usual ("${esc(example)}"); the card will offer to link it.`,
      keyboard: [BACK],
    };
  }
  const keyboard: Keyboard = near.map((c) => [{ text: toggleLabel(c.row, c.ticked), callback_data: `r:bt:${c.row.id}` }]);
  keyboard.push([{ text: "", callback_data: `r:bk:${sid}` }], BACK);
  return {
    text: [
      `<b>🔍 ${esc(series.name)} around ${when}</b>`,
      `${near.length} unlinked payment${near.length === 1 ? " looks" : "s look"} like it. ✅ links it; ☐ leaves it out of this series for good.`,
    ].join("\n"),
    keyboard: recount(keyboard),
  };
}

const OUT_OF_DATE = "That button is out of date. Open /recurring.";

/**
 * Why a slot cannot be skipped now, or null when the slot dated exactly `due`
 * is due or not logged. A skip settles the slot nearest its date, so a date
 * that is no slot's (the series' dates moved since the button was drawn, or
 * a made-up button) could settle a different payment than the one checked:
 * it is refused, and a skip is only ever stored at a slot's own date.
 */
function unskippable(book: Book, sid: number, due: string, today: string): string | null {
  const series = book.series.find((s) => s.id === sid);
  if (!series) return "That series no longer exists.";
  const slots = viewOf(book, series, today).slots;
  const slot = slots.find((s) => s.due === due);
  if (!slot && slots.some((s) => Math.abs(dayNumber(s.due) - dayNumber(due)) <= halfPeriod(series.cadence))) {
    return OUT_OF_DATE;
  }
  switch (slot?.status) {
    case "due":
    case "missed":
      return null;
    case "met":
      return "Already logged: nothing to skip.";
    case "skipped":
      return "Already skipped.";
    case "paused":
      return "Paused then: nothing to skip.";
    default:
      return `Nothing expected around ${dayIn(due, today)}.`;
  }
}

type Outcome = { screen?: Screen; ack?: string };

/** The digest of that day as it is now, or a line saying nothing is left. */
async function redraw(chatId: number, runDay: string): Promise<Screen> {
  const digest = await loadDigest(chatId, runDay);
  return digest ?? { text: `Nothing left to do for ${day(runDay)}.`, keyboard: [[{ text: "↻ All recurring", callback_data: "r:l:0" }]] };
}

async function respond(tap: DigestTap, ctx: TapContext): Promise<Outcome> {
  if (tap.op === "find") return { screen: findScreen(await loadBook(), tap.sid, tap.due, ctx.today) };
  // Writes and redraws need the digest this message is: never act on another message.
  const day = await runDay(ctx.chatId, ctx.messageId);
  if (day === null) return { ack: "That digest is no longer current. Open /recurring." };
  if (tap.op === "back") return { screen: await redraw(ctx.chatId, day) };
  const when = dayIn(tap.due, ctx.today);
  if (tap.op === "unskip") {
    if (!(await unskipSlot(tap.sid, tap.due))) return { ack: "Already undone." };
    return { screen: await redraw(ctx.chatId, day), ack: `${when} is expected again.` };
  }
  const why = unskippable(await loadBook(), tap.sid, tap.due, ctx.today);
  if (why) return { ack: why };
  const result = await skipSlot(tap.sid, tap.due, new Date());
  if (result === "already") return { ack: "Already skipped." };
  if (result === "missing") return { ack: "That series no longer exists." };
  return { screen: await redraw(ctx.chatId, day), ack: `Skipped ${when}.` };
}

/** A tap on a digest button: the message is edited in place, then the tap answered. */
export async function handleDigestTap(tap: DigestTap, ctx: TapContext): Promise<void> {
  const outcome = await respond(tap, ctx);
  if (outcome.screen) {
    await editMessageText(ctx.botToken, ctx.chatId, ctx.messageId, outcome.screen.text, outcome.screen.keyboard, {
      html: true,
    });
  }
  await answerCallbackQuery(ctx.botToken, ctx.callbackId, outcome.ack);
}
