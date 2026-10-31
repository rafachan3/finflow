/**
 * The recurring series a confirmation card proposes (design §E.6, P1): the
 * series the payment matches strongly, and a note when its amount is outside
 * the series' usual band. The card links to it on Confirm unless the owner
 * turns it off; a weak match is left to the series' review. No Gemini call.
 */
import type { Extraction } from "./extraction.js";
import { amountBand, bestMatch, matchStrength, outsideBand, type LedgerRow } from "./recurring.js";
import { cardRow, loadBook, type Book } from "./recurring-db.js";
import { money } from "./recurring-menu.js";

export type CardSeries = {
  id: number;
  name: string;
  /** `↻ Phone bill · usually 45.00; this is 61.25 (+16.25)`; null inside the band or when the amount varies. */
  note: string | null;
};

/** The series a payment would join, or null when none matches strongly. */
export function proposal(book: Book, row: LedgerRow): CardSeries | null {
  const histories = book.series.map((series) => ({
    series,
    linked: book.rows.filter((r) => r.seriesId === series.id),
    excluded: book.excluded.get(series.id) ?? [],
    pauses: book.pauses.get(series.id) ?? [],
  }));
  const best = bestMatch(histories.map((h) => matchStrength(h, row)));
  if (best?.strength !== "strong") return null;
  const { series, linked } = histories.find((h) => h.series.id === best.seriesId)!;
  const band = amountBand(linked.map((r) => r.amount), series.amountVaries);
  const off = band ? outsideBand(band, row.amount) : null;
  const note =
    band && off !== null
      ? `↻ ${series.name} · usually ${money(band.typical)}; this is ${money(band.typical + off)} (${off > 0 ? "+" : ""}${money(off)})`
      : null;
  return { id: series.id, name: series.name, note };
}

/** The series a pending card proposes; reads the recurring book. */
export async function cardSeries(cardId: string, extraction: Extraction): Promise<CardSeries | null> {
  const book = await loadBook();
  if (book.series.length === 0) return null;
  return proposal(book, await cardRow(cardId, extraction));
}
