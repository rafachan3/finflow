import { APOSTROPHE_VARIANTS, collapseSpaces, merchantKey } from "./commands.js";

/**
 * The review /addmerchant offers for transactions that only mention the
 * merchant. Stateless: what is ticked lives in the message's own inline
 * keyboard, which Telegram sends back with every tap.
 */

/** A transaction with no merchant whose message, caption or description mentions one. */
export type Mention = {
  id: string;
  date: string;
  amount: string;
  description: string;
  /** The message text or caption, when that is where the merchant is mentioned. */
  said: string | null;
};

export type Keyboard = { text: string; callback_data: string }[][];

export const MENTIONS_PAGE = 8;

const BOX = "☐";
const TICK = "✅";
const SNIPPET_MAX = 30;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOGGLE = new RegExp(`^mt:(${UUID})$`, "i");
const LINK = /^ml:(\d{1,10})$/;
const MORE = new RegExp(`^mp:(\\d{1,10}):(${UUID})$`, "i");

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The Postgres regex db.ts matches against MERCHANT_KEY(text): the merchant's
 * key as a whole word or phrase, so "lark" is found in "lark ticket" but not
 * in "larkspur".
 */
export function mentionPattern(name: string): string {
  return `(^|[^[:alnum:]_])${escapeRegex(merchantKey(name))}($|[^[:alnum:]_])`;
}

/** The same match in the original text, for placing the label's snippet. */
function mentionRegex(name: string): RegExp {
  const body = [...merchantKey(name)]
    .map((c) => (c === " " ? "\\s+" : c === "'" ? `['${APOSTROPHE_VARIANTS}]` : escapeRegex(c)))
    .join("");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
}

/** Up to SNIPPET_MAX characters of `text` around the mention, with … where it was cut. */
function snippet(text: string, name: string): string | null {
  const t = collapseSpaces(text);
  const m = mentionRegex(name).exec(t);
  if (!m) return null;
  if (t.length <= SNIPPET_MAX) return t;
  // Centre the mention; a window that hits one end of the text takes the slack from the other.
  const centred = Math.max(0, m.index - Math.floor((SNIPPET_MAX - m[0].length) / 2));
  let stop = Math.min(t.length, Math.max(centred + SNIPPET_MAX, m.index + m[0].length));
  let start = Math.max(0, Math.min(centred, stop - SNIPPET_MAX));
  // Drop a word cut in half at either edge, never the mention itself.
  if (start > 0 && t[start - 1] !== " ") {
    const space = t.indexOf(" ", start);
    if (space !== -1 && space < m.index) start = space + 1;
  }
  if (stop < t.length && t[stop] !== " ") {
    const space = t.lastIndexOf(" ", stop);
    if (space >= m.index + m[0].length) stop = space;
  }
  return `${start > 0 ? "…" : ""}${t.slice(start, stop).trim()}${stop < t.length ? "…" : ""}`;
}

function cut(text: string): string {
  const t = collapseSpaces(text);
  return t.length <= SNIPPET_MAX ? t : `${t.slice(0, SNIPPET_MAX).trim()}…`;
}

function day(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** `☐ Sep 15 · 12.50 · "…words around the match…"`, the description when the match can't be placed. */
export function mentionLabel(m: Mention, name: string): string {
  const where =
    (m.said !== null ? snippet(m.said, name) : null) ?? snippet(m.description, name) ?? cut(m.description);
  return `${BOX} ${day(m.date)} · ${m.amount} · "${where}"`;
}

/** One review message: a toggle per mention, the actions, and More when more remain after these. */
export function mentionsMessage(
  merchantId: number,
  name: string,
  page: { total: number; rows: Mention[] },
  continued: boolean,
): { text: string; keyboard: Keyboard } {
  const more = continued ? " more" : "";
  const keyboard: Keyboard = page.rows.map((m) => [{ text: mentionLabel(m, name), callback_data: `mt:${m.id}` }]);
  keyboard.push([
    { text: "Link selected", callback_data: `ml:${merchantId}` },
    { text: "Select all", callback_data: "ma" },
    { text: "Skip", callback_data: "ms" },
  ]);
  if (page.total > page.rows.length) {
    keyboard.push([{ text: "More ›", callback_data: `mp:${merchantId}:${page.rows.at(-1)!.id}` }]);
  }
  return {
    text: `Check ${page.total}${more} that mention${page.total === 1 ? "s" : ""} ${name}. Tap to pick, then Link:`,
    keyboard,
  };
}

export type MentionTap =
  | { kind: "toggle" }
  | { kind: "all" }
  | { kind: "skip" }
  | { kind: "link"; merchantId: number }
  | { kind: "more"; merchantId: number; after: string };

/** A review button's action, or null for any other callback data. */
export function parseMentionTap(data: string | undefined): MentionTap | null {
  if (data === undefined) return null;
  if (TOGGLE.test(data)) return { kind: "toggle" };
  if (data === "ma") return { kind: "all" };
  if (data === "ms") return { kind: "skip" };
  const link = LINK.exec(data);
  if (link) return { kind: "link", merchantId: Number(link[1]) };
  const more = MORE.exec(data);
  if (more) return { kind: "more", merchantId: Number(more[1]), after: more[2] };
  return null;
}

function mapToggles(keyboard: Keyboard, f: (b: Keyboard[number][number]) => string): Keyboard {
  return keyboard.map((row) =>
    row.map((b) => (TOGGLE.test(b.callback_data) ? { ...b, text: f(b) } : b)),
  );
}

function flip(text: string): string {
  if (text.startsWith(BOX)) return TICK + text.slice(BOX.length);
  if (text.startsWith(TICK)) return BOX + text.slice(TICK.length);
  return text;
}

export function toggle(keyboard: Keyboard, data: string): Keyboard {
  return mapToggles(keyboard, (b) => (b.callback_data === data ? flip(b.text) : b.text));
}

export function selectAll(keyboard: Keyboard): Keyboard {
  return mapToggles(keyboard, (b) => (b.text.startsWith(BOX) ? flip(b.text) : b.text));
}

/** The transaction ids ticked on the keyboard, and how many it offers. */
export function ticked(keyboard: Keyboard): { ids: string[]; shown: number } {
  const toggles = keyboard.flat().filter((b) => TOGGLE.test(b.callback_data));
  return {
    ids: toggles.filter((b) => b.text.startsWith(TICK)).map((b) => b.callback_data.slice(3)),
    shown: toggles.length,
  };
}

export function withoutMore(keyboard: Keyboard): Keyboard {
  return keyboard.filter((row) => !row.some((b) => MORE.test(b.callback_data)));
}

export function linkedSummary(r: { name: string; linked: number; picked: number; shown: number }): string {
  const had = r.picked - r.linked;
  const note = had > 0 ? ` ${had} already had a merchant.` : "";
  return `Linked ${r.linked} of ${r.shown} to ${r.name}.${note}`;
}

export const PICK_FIRST = "Tap the ones to link first, or Skip.";
export const MERCHANT_GONE = "Nothing linked: that merchant was deleted or hidden.";
export const NO_MORE = "Nothing more to check.";
