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
 * `r:x:<sid>` / `r:xy:<sid>` delete, asked then done ·
 * `r:a`, `r:ar:<offset>` pick a saved payment → `r:at:<uuid>` add from it,
 * `r:av` flips "amount varies" in the keyboard only, `r:ac:<uuid>:<c><v>`
 * creates the series with cadence code c and varies flag v.
 * Dates are yyyymmdd.
 */
import { collapseSpaces } from "./commands.js";
import { parseCents, parseDateReply } from "./extraction.js";
import { flip, selectAll, ticked, toggle, type Keyboard } from "./mentions.js";
import {
  amountBand,
  dayNumber,
  matchStrength,
  occurrences,
  proposeSeries,
  suggestCadence,
  type Band,
  type Cadence,
  type Fit,
  type Pause,
  type Series,
  type Slot,
} from "./recurring.js";
import {
  applyReview,
  clearFlags,
  createSeries,
  deleteSeries,
  dismissGroup,
  loadBook,
  pauseSeries,
  renameSeries,
  resumeSeries,
  type Book,
  type BookRow,
  type BookSeries,
} from "./recurring-db.js";
import { answerCallbackQuery, editMessageReplyMarkup, editMessageText, esc, sendMessage } from "./telegram.js";

export type Screen = { text: string; keyboard: Keyboard };

export type RecurringTap =
  | { op: "list"; offset: number }
  | { op: "view" | "pause" | "rename" | "askDelete" | "delete"; sid: number }
  | { op: "pauseFrom" | "pauseDate"; sid: number; from: string }
  | { op: "pauseUntil"; sid: number; from: string; until: string | null }
  | { op: "resume"; sid: number; on: string }
  | { op: "pick"; offset: number }
  | { op: "addFrom"; tx: string }
  | { op: "varies" }
  | { op: "create"; tx: string; cadence: Cadence; varies: boolean }
  | { op: "review"; sid: number | null }
  | { op: "toggle"; data: string }
  | { op: "all" | "later" | "clear" | "suggestions" }
  | { op: "apply"; sid: number }
  | { op: "flags"; offset: number }
  | { op: "dismiss"; tx: string };

const SID = "(\\d{1,10})";
const DATE = "(\\d{8})";
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

/** One letter per cadence in `r:ac` data. */
const CODES: Record<string, Cadence> = {
  w: "weekly",
  b: "biweekly",
  s: "semimonthly",
  m: "monthly",
  q: "quarterly",
  y: "yearly",
};

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
  [/^r:a(?:r:(\d{1,4}))?$/, (m) => ({ op: "pick", offset: Number(m[1] ?? 0) })],
  [new RegExp(`^r:at:${UUID}$`), (m) => ({ op: "addFrom", tx: m[1] })],
  [/^r:av$/, () => ({ op: "varies" })],
  [
    new RegExp(`^r:ac:${UUID}:([wbsmqy])([01])$`),
    (m) => ({ op: "create", tx: m[1], cadence: CODES[m[2]], varies: m[3] === "1" }),
  ],
  [new RegExp(`^r:b(?::${SID})?$`), (m) => ({ op: "review", sid: m[1] === undefined ? null : Number(m[1]) })],
  [new RegExp(`^r:[bf]t:${UUID}$`), (m) => ({ op: "toggle", data: m[0] })],
  [/^r:ba$/, () => ({ op: "all" })],
  [new RegExp(`^r:bk:${SID}$`), (m) => ({ op: "apply", sid: Number(m[1]) })],
  [/^r:bl$/, () => ({ op: "later" })],
  [/^r:f:(\d{1,4})$/, (m) => ({ op: "flags", offset: Number(m[1]) })],
  [/^r:fk$/, () => ({ op: "clear" })],
  [/^r:sg$/, () => ({ op: "suggestions" })],
  [new RegExp(`^r:gd:${UUID}$`), (m) => ({ op: "dismiss", tx: m[1] })],
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
  const views = page.map((s) => viewOf(book, s, today));
  for (const [kind, heading] of KINDS) {
    const of = views.filter((v) => v.series.kind === kind);
    if (of.length === 0) continue;
    lines.push(`<b>${heading}</b>`);
    for (const v of of) lines.push(`• ${esc(v.series.name)} — ${summary(v)}`);
  }
  const keyboard: Keyboard = [];
  for (let i = 0; i < views.length; i += 2) {
    keyboard.push(
      views.slice(i, i + 2).map((v) => ({
        text: `${cut(v.series.name, 30)}${v.pausedNow ? " ⏸" : ""}`,
        callback_data: `r:v:${v.series.id}`,
      })),
    );
  }
  // The leftovers (design §D.3, P3): nothing half-linked goes unnoticed.
  const review = toReview(book).size;
  const suggestions = proposeSeries(book.rows, book.dismissed, today).length;
  const flagged = flaggedRows(book).length;
  const counts = [
    review > 0 ? `🧹 ${review} to review` : "",
    suggestions > 0 ? `🔎 ${suggestions} suggestion${suggestions === 1 ? "" : "s"}` : "",
    flagged > 0 ? `⚑ ${flagged} flagged, no series` : "",
  ].filter(Boolean);
  if (counts.length > 0) lines.push(counts.join(" · "));
  const todo = [
    ...(review > 0 ? [{ text: `🧹 Review (${review})`, callback_data: "r:b" }] : []),
    ...(suggestions > 0 ? [{ text: `🔎 Suggestions (${suggestions})`, callback_data: "r:sg" }] : []),
    ...(flagged > 0 ? [{ text: `⚑ Flagged (${flagged})`, callback_data: "r:f:0" }] : []),
  ];
  if (todo.length > 0) keyboard.push(todo);
  const last = [{ text: "➕ Add", callback_data: "r:a" }];
  if (sorted.length > offset + LIST_PAGE) last.push({ text: "More ›", callback_data: `r:l:${offset + LIST_PAGE}` });
  keyboard.push(last);
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
  const review = candidates(book, series).length;
  if (review > 0) lines.push(`🧹 ${payments(review)} to review`);
  return {
    text: lines.join("\n"),
    keyboard: [
      [...manage, { text: "✏️ Rename", callback_data: `r:n:${sid}` }],
      [
        ...(review > 0 ? [{ text: `🧹 Review matches (${review})`, callback_data: `r:b:${sid}` }] : []),
        { text: "🗑 Delete", callback_data: `r:x:${sid}` },
      ],
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

// ---- Add from a saved transaction ------------------------------------------

const PICK_PAGE = 8;
const MONTH_WORD =
  /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)[.,]?$/i;

/** `Oct 15 · 64.99 · Internet bill October`, cut to fit a button. */
function rowLabel(r: BookRow, max = 40): string {
  return cut(`${day(r.date)} · ${money(parseCents(r.amount)!)} · ${collapseSpaces(r.description)}`, max);
}

/**
 * A series' default name: the merchant, else the income source, else the
 * description without digits or month names ("Internet bill October" →
 * "Internet bill"); with a number after it when another series has it.
 */
export function defaultName(book: Book, r: BookRow): string {
  const words = collapseSpaces(r.description).split(" ").filter((w) => !/\d/.test(w) && !MONTH_WORD.test(w));
  const base = cut(r.merchant ?? r.source ?? capitalise(words.join(" ") || collapseSpaces(r.description)), 56);
  const taken = new Set(book.series.map((s) => s.name.trim().toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

/** The series a transaction would start: its kind and its keys. */
function draftOf(r: BookRow, name: string): Series {
  return {
    id: 0,
    name,
    kind: r.type,
    cadence: "monthly",
    amountVaries: false,
    merchantId: r.type === "expense" ? r.merchantId : null,
    subcategoryId: r.type === "expense" ? r.subcategoryId : null,
    incomeSourceId: r.type === "income" ? r.incomeSourceId : null,
    fromAccountId: r.type === "transfer" ? r.fromAccountId : null,
    toAccountId: r.type === "transfer" ? r.toAccountId : null,
    keywords: [],
  };
}

/** Add, step 1: the newest saved payments in no series, 8 a page. */
export function pickScreen(book: Book, offset: number): Screen {
  const free = book.rows.filter((r) => r.seriesId === null).reverse();
  const page = free.slice(offset, offset + PICK_PAGE);
  const keyboard: Keyboard = page.map((r) => [{ text: rowLabel(r), callback_data: `r:at:${r.id}` }]);
  const last = [BACK_TO_LIST[0]];
  if (free.length > offset + PICK_PAGE) last.push({ text: "More ›", callback_data: `r:ar:${offset + PICK_PAGE}` });
  keyboard.push(last);
  const text =
    free.length === 0
      ? "<b>➕ Add a recurring item</b>\nNo saved payment is outside a series. Log the first one as usual, then come back."
      : "<b>➕ Add a recurring item</b>\nPick a saved payment that repeats. Newest first; payments already in a series are not listed.";
  return { text, keyboard };
}

const CADENCE_ORDER: Cadence[] = ["monthly", "semimonthly", "biweekly", "weekly", "quarterly", "yearly"];
const CADENCE_BUTTONS: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};
const CODE_OF = Object.fromEntries(Object.entries(CODES).map(([c, cadence]) => [cadence, c])) as Record<Cadence, string>;

/**
 * Add, step 2: the series this payment would start, with the cadence its
 * similar past payments suggest listed first. Writes nothing; a cadence tap
 * creates it.
 */
export function addScreen(book: Book, txId: string): Screen {
  const back = [[{ text: "‹ Back", callback_data: "r:a" }]];
  const r = book.rows.find((x) => x.id === txId);
  if (!r) return { text: "That payment no longer exists.", keyboard: back };
  if (r.seriesId !== null) {
    const s = book.series.find((x) => x.id === r.seriesId)!;
    return {
      text: `That payment is already in ${esc(s.name)}.`,
      keyboard: [[{ text: `↻ ${cut(s.name, 30)}`, callback_data: `r:v:${s.id}` }], ...back],
    };
  }
  const name = defaultName(book, r);
  const draft = { series: draftOf(r, name), linked: [r], excluded: [], pauses: [] };
  const similar = book.rows.filter(
    (x) => x.id !== r.id && x.seriesId === null && matchStrength(draft, x).strength === "strong",
  );
  const dates = [r, ...similar].map((x) => x.date).sort();
  const best = suggestCadence(dates).best;
  const suggested = best && best.score >= 0.5 ? best : null;
  const lines = [
    "<b>➕ New recurring item</b>",
    `From ${esc(rowLabel(r, 200))}`,
    `Name: ${esc(name)} (rename after)`,
    suggested
      ? `History: ${payments(dates.length)} since ${day(dates[0])}, looks ${cadenceText(suggested.cadence, suggested)}.`
      : `History: ${payments(dates.length)}, not enough to tell. Pick how often.`,
  ];
  const order = suggested ? [suggested.cadence, ...CADENCE_ORDER.filter((c) => c !== suggested.cadence)] : CADENCE_ORDER;
  const buttons = order.map((c) => ({
    text: `${c === suggested?.cadence ? "✅ " : ""}${CADENCE_BUTTONS[c]}`,
    callback_data: `r:ac:${r.id}:${CODE_OF[c]}0`,
  }));
  return {
    text: lines.join("\n"),
    keyboard: [buttons.slice(0, 3), buttons.slice(3), [{ text: "☐ Amount varies", callback_data: "r:av" }], ...back],
  };
}

/** "Amount varies" flipped in the keyboard: its label, and the v flag of every cadence button. Stores nothing. */
export function flipVaries(keyboard: Keyboard): Keyboard {
  const on = keyboard.flat().some((b) => b.callback_data === "r:av" && b.text.startsWith("☐"));
  return keyboard.map((row) =>
    row.map((b) =>
      b.callback_data === "r:av"
        ? { ...b, text: flip(b.text) }
        : b.callback_data.startsWith("r:ac:")
          ? { ...b, callback_data: `${b.callback_data.slice(0, -1)}${on ? 1 : 0}` }
          : b,
    ),
  );
}

// ---- Verify past payments, legacy flags, suggestions ------------------------

const REVIEW_PAGE = 8;
/** The toggles of the review (`r:bt`) and legacy-flag (`r:ft`) screens. */
const REVIEW_TOGGLE = new RegExp(`^r:[bf]t:${UUID}$`);

/**
 * A series' unresolved candidates, newest first: payments in no series, not
 * excluded from it, that match it strongly or weakly. Strong ones and those
 * flagged recurring before are ticked; weak ones are not.
 */
function candidates(book: Book, s: BookSeries): { row: BookRow; ticked: boolean }[] {
  const history = {
    series: s,
    linked: book.rows.filter((r) => r.seriesId === s.id),
    excluded: book.excluded.get(s.id) ?? [],
    pauses: book.pauses.get(s.id) ?? [],
  };
  return book.rows
    .filter((r) => r.seriesId === null)
    .map((row) => ({ row, strength: matchStrength(history, row).strength }))
    .filter((c) => c.strength !== "none")
    .map(({ row, strength }) => ({ row, ticked: strength === "strong" || row.flagged }))
    .reverse();
}

/** Every payment some series still offers for review. */
function toReview(book: Book): Set<string> {
  return new Set(book.series.flatMap((s) => candidates(book, s).map((c) => c.row.id)));
}

/** Rows flagged recurring by the import or Gemini's guess but in no series, newest first. */
function flaggedRows(book: Book): BookRow[] {
  return book.rows.filter((r) => r.flagged && r.seriesId === null).reverse();
}

function toggleLabel(r: BookRow, ticked: boolean): string {
  return `${ticked ? "✅" : "☐"} ${r.flagged ? "⚑ " : ""}${rowLabel(r, 36)}`;
}

/**
 * Rewrites the Apply and Clear labels from the ticks, so a button always
 * says what it will write: `✅ Link 5 · ignore 3`, `Clear flag on ticked (2)`.
 */
export function recount(keyboard: Keyboard): Keyboard {
  const { ids, shown } = ticked(keyboard, REVIEW_TOGGLE);
  return keyboard.map((row) =>
    row.map((b) =>
      b.callback_data.startsWith("r:bk:")
        ? { ...b, text: `✅ Link ${ids.length} · ignore ${shown - ids.length}` }
        : b.callback_data === "r:fk"
          ? { ...b, text: `Clear flag on ticked (${ids.length})` }
          : b,
    ),
  );
}

/**
 * Verify, one page of one series: its candidates as toggles and an Apply
 * that links the ticked and ignores the rest shown. Writes nothing. With no
 * candidates left, what the series holds now.
 */
export function reviewScreen(book: Book, sid: number, today: string): Screen {
  const series = book.series.find((s) => s.id === sid);
  if (!series) return GONE;
  const found = candidates(book, series);
  if (found.length === 0) {
    const v = viewOf(book, series, today);
    const ignored = (book.excluded.get(sid) ?? []).length;
    const others = toReview(book).size;
    const flagged = flaggedRows(book).length;
    const next = others > 0
      ? [{ text: `🧹 Review next (${others})`, callback_data: "r:b" }]
      : flagged > 0
        ? [{ text: `⚑ Flagged, no series (${flagged})`, callback_data: "r:f:0" }]
        : [];
    return {
      text: [
        `<b>🧹 ${esc(series.name)}</b>`,
        `Nothing left to review: ${payments(v.linked.length)} linked, ${ignored} ignored.`,
        `${capitalise(cadenceText(series.cadence, v.fit))}.`,
      ].join("\n"),
      keyboard: [
        ...(next.length ? [next] : []),
        // For a series that bills again only later (a free trial, a paused plan).
        [{ text: "⏳ Next payment not until…", callback_data: `r:pd:${sid}:${compact(today)}` }],
        [{ text: `‹ ${cut(series.name, 30)}`, callback_data: `r:v:${sid}` }, BACK_TO_LIST[0]],
      ],
    };
  }
  const page = found.slice(0, REVIEW_PAGE);
  const keyboard: Keyboard = page.map((c) => [{ text: toggleLabel(c.row, c.ticked), callback_data: `r:bt:${c.row.id}` }]);
  keyboard.push([{ text: "", callback_data: `r:bk:${sid}` }]);
  keyboard.push([
    { text: "Select all", callback_data: "r:ba" },
    { text: "Later", callback_data: "r:bl" },
  ]);
  return {
    text: [
      `<b>🧹 ${esc(series.name)}: past payments that look like it</b>`,
      `${page.length < found.length ? `Showing ${page.length} of ${found.length}.` : `${payments(found.length)}.`} ✅ links it; ☐ leaves it out of this series for good.`,
      "Ticked: same name, merchant or source. Unticked: only the same category, amount and timing. ⚑ was flagged recurring.",
    ].join("\n"),
    keyboard: recount(keyboard),
  };
}

/** The first series with candidates, else the legacy flags. */
function nextReview(book: Book, today: string): Screen {
  const s = book.series.find((x) => candidates(book, x).length > 0);
  return s ? reviewScreen(book, s.id, today) : flagsScreen(book, 0);
}

/**
 * Legacy flags: rows flagged recurring that are in no series, 8 a page. A
 * toggle per row and ➕ to make a series from it; Clear writes. When the
 * list is empty, migration 0017's CHECK can ship.
 */
export function flagsScreen(book: Book, offset: number): Screen {
  const rows = flaggedRows(book);
  if (rows.length === 0) {
    return { text: "<b>⚑ Flagged recurring, in no series</b>\nNone left: every recurring flag belongs to a series.", keyboard: [BACK_TO_LIST] };
  }
  const page = rows.slice(offset, offset + REVIEW_PAGE);
  const keyboard: Keyboard = page.map((r) => [
    { text: `☐ ${rowLabel(r, 34)}`, callback_data: `r:ft:${r.id}` },
    { text: "➕", callback_data: `r:at:${r.id}` },
  ]);
  keyboard.push([
    { text: "", callback_data: "r:fk" },
    { text: "Select all", callback_data: "r:ba" },
  ]);
  const nav = [BACK_TO_LIST[0]];
  if (rows.length > offset + REVIEW_PAGE) nav.push({ text: "More ›", callback_data: `r:f:${offset + REVIEW_PAGE}` });
  keyboard.push(nav);
  return {
    text: [
      `<b>⚑ Flagged recurring, in no series (${rows.length})</b>`,
      `Showing ${offset + 1}–${offset + page.length}. Tick to clear the flag, or ➕ to make a series from that payment.`,
    ].join("\n"),
    keyboard: recount(keyboard),
  };
}

/** Detector proposals: one line each, Track (the add flow) or Not recurring. */
export function suggestionsScreen(book: Book, today: string): Screen {
  const found = proposeSeries(book.rows, book.dismissed, today).slice(0, 6);
  if (found.length === 0) return { text: "<b>🔎 Possible recurring items</b>\nNothing new spotted.", keyboard: [BACK_TO_LIST] };
  const lines = [`<b>🔎 Possible recurring items (${found.length})</b>`];
  const keyboard: Keyboard = [];
  for (const p of found) {
    const members = book.rows.filter((r) => p.transactionIds.includes(r.id));
    const newest = members[members.length - 1];
    const name = defaultName(book, newest);
    const band = amountBand(members.map((r) => r.amount));
    lines.push(`• ${esc(name)} — ${cadenceText(p.fit.cadence, p.fit)} · ${payments(members.length)} · ~${money(band!.typical)}`);
    keyboard.push([
      { text: `🔎 Track ${cut(name, 24)}`, callback_data: `r:at:${newest.id}` },
      { text: "Not recurring", callback_data: `r:gd:${newest.id}` },
    ]);
  }
  keyboard.push(BACK_TO_LIST);
  return { text: lines.join("\n"), keyboard };
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
type Outcome = { screen?: Screen; keyboard?: Keyboard; prompt?: string; ack?: string };

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
    case "pick":
      return { screen: pickScreen(await loadBook(), tap.offset) };
    case "addFrom":
      return { screen: addScreen(await loadBook(), tap.tx) };
    case "varies":
      return { keyboard: flipVaries(ctx.keyboard) };
    case "create": {
      const book = await loadBook();
      const row = book.rows.find((r) => r.id === tap.tx);
      if (!row) return { screen: addScreen(book, tap.tx) };
      const name = defaultName(book, row);
      const result = await createSeries({ transactionId: tap.tx, name, cadence: tap.cadence, amountVaries: tap.varies });
      // Every series creation reviews all history at once (design §D.3, P2).
      if ("created" in result) return { screen: reviewScreen(await loadBook(), result.created, ctx.today), ack: `Tracking ${name}.` };
      if ("already" in result) return { ack: `Already tracked as ${result.name}.` };
      if ("taken" in result) return { ack: "That name was just taken. Tap again." };
      if ("missing" in result) return { screen: addScreen(await loadBook(), tap.tx) };
      return { ack: "Can't make a series from this payment." };
    }
    case "review": {
      const book = await loadBook();
      return { screen: tap.sid === null ? nextReview(book, ctx.today) : reviewScreen(book, tap.sid, ctx.today) };
    }
    // Ticks live in the keyboard: these edit it and write nothing.
    case "toggle":
      return { keyboard: recount(toggle(ctx.keyboard, tap.data, REVIEW_TOGGLE)) };
    case "all":
      return { keyboard: recount(selectAll(ctx.keyboard, REVIEW_TOGGLE)) };
    case "later":
      return { keyboard: [], ack: "Left for later: /recurring, then 🧹 Review." };
    case "apply": {
      const { ids, all } = ticked(ctx.keyboard, REVIEW_TOGGLE);
      const result = await applyReview(tap.sid, ids, all.filter((id) => !ids.includes(id)));
      if (!result) return { screen: GONE };
      if (result.linked + result.ignored === 0) return { ack: "Already applied." };
      return {
        screen: reviewScreen(await loadBook(), tap.sid, ctx.today),
        ack: `Linked ${result.linked}, ignored ${result.ignored}.`,
      };
    }
    case "flags":
      return { screen: flagsScreen(await loadBook(), tap.offset) };
    case "clear": {
      const { ids } = ticked(ctx.keyboard, REVIEW_TOGGLE);
      if (ids.length === 0) return { ack: "Tick the ones to clear first." };
      const cleared = await clearFlags(ids);
      if (cleared === 0) return { ack: "Already cleared." };
      return { screen: flagsScreen(await loadBook(), 0), ack: `Cleared ${cleared}.` };
    }
    case "suggestions":
      return { screen: suggestionsScreen(await loadBook(), ctx.today) };
    case "dismiss": {
      const book = await loadBook();
      const proposal = proposeSeries(book.rows, book.dismissed, ctx.today).find((p) => p.transactionIds.includes(tap.tx));
      if (!proposal) return { ack: "Already dismissed." };
      await dismissGroup(proposal.key);
      return { screen: suggestionsScreen(await loadBook(), ctx.today), ack: "Won't suggest it again." };
    }
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
  // Telegram refuses an edit that changes nothing.
  if (outcome.keyboard && JSON.stringify(outcome.keyboard) !== JSON.stringify(ctx.keyboard)) {
    await editMessageReplyMarkup(ctx.botToken, ctx.chatId, ctx.messageId, { inline_keyboard: outcome.keyboard });
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
