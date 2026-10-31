/**
 * Postgres reads and writes for recurring series (migration 0016). Every
 * screen reads the whole book, a few hundred rows, and derives windows,
 * bands and candidates in recurring.ts; nothing derived is stored. Each write
 * is one statement, so it applies whole or not at all, and each is safe to
 * repeat: a double tap or a Telegram retry finds the work done and reports
 * that instead of doing it twice.
 */
import { getPool, hasCode } from "./db.js";
import type { Cadence, LedgerRow, Pause, Series } from "./recurring.js";

/** A saved transaction as the recurring screens read it. */
export interface BookRow extends LedgerRow {
  /** is_recurring: true when linked, or a legacy flag (Gemini's guess, the Notion import) with no series. */
  flagged: boolean;
  merchant: string | null;
  source: string | null;
}

export interface BookSeries extends Series {
  /** "Bills › Internet and phone" when the series matches on a subcategory. */
  subcategory: string | null;
  /** An income series' source. */
  source: string | null;
  /** A transfer series' accounts; null is chequing. */
  fromAccount: string | null;
  toAccount: string | null;
}

export interface Book {
  series: BookSeries[];
  /** Every transaction, oldest first. */
  rows: BookRow[];
  pauses: Map<number, Pause[]>;
  skips: Map<number, string[]>;
  /** Transaction ids the owner said are not that series. */
  excluded: Map<number, string[]>;
  dismissed: string[];
}

/** The subcategory of a transaction's largest line; null with no lines. */
const DOMINANT_SUBCATEGORY = (t: string) =>
  `(SELECT i.subcategory_id FROM transaction_items i WHERE i.transaction_id = ${t}.id
    ORDER BY i.amount DESC, i.id LIMIT 1)`;

function byId<T>(rows: { id: number; value: T }[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const { id, value } of rows) out.set(id, [...(out.get(id) ?? []), value]);
  return out;
}

/** Every series, transaction, pause, skip, exclusion and dismissal. */
export async function loadBook(): Promise<Book> {
  const db = await getPool();
  // Sequential on one pooled connection (max 1).
  const series = await db.query<BookSeries>(
    `SELECT s.id, s.name, s.kind::text AS kind, s.cadence::text AS cadence,
            s.amount_varies AS "amountVaries", s.merchant_id AS "merchantId",
            s.subcategory_id AS "subcategoryId", s.income_source_id AS "incomeSourceId",
            s.from_account_id AS "fromAccountId", s.to_account_id AS "toAccountId", s.keywords,
            c.name || ' › ' || sc.name AS subcategory, src.name AS source,
            fa.name AS "fromAccount", ta.name AS "toAccount"
     FROM recurring_series s
     LEFT JOIN subcategories sc ON sc.id = s.subcategory_id
     LEFT JOIN categories c ON c.id = sc.category_id
     LEFT JOIN income_sources src ON src.id = s.income_source_id
     LEFT JOIN accounts fa ON fa.id = s.from_account_id
     LEFT JOIN accounts ta ON ta.id = s.to_account_id
     ORDER BY lower(s.name), s.id`,
  );
  const rows = await db.query<BookRow>(
    `SELECT t.id::text, t.occurred_on::text AS date, t.type::text AS type, t.amount::text AS amount,
            t.description, t.merchant_id AS "merchantId",
            ${DOMINANT_SUBCATEGORY("t")} AS "subcategoryId",
            t.income_source_id AS "incomeSourceId", t.from_account_id AS "fromAccountId",
            t.to_account_id AS "toAccountId", t.recurring_series_id AS "seriesId",
            t.is_recurring AS flagged, m.name AS merchant, src.name AS source
     FROM transactions t
     LEFT JOIN merchants m ON m.id = t.merchant_id
     LEFT JOIN income_sources src ON src.id = t.income_source_id
     ORDER BY t.occurred_on, t.created_at, t.id`,
  );
  const pauses = await db.query<{ id: number; from: string; until: string | null }>(
    `SELECT series_id AS id, paused_from::text AS "from", resumed_on::text AS "until"
     FROM recurring_pauses ORDER BY series_id, paused_from`,
  );
  const skips = await db.query<{ id: number; due: string }>(
    `SELECT series_id AS id, due_on::text AS due FROM recurring_skips ORDER BY series_id, due_on`,
  );
  const excluded = await db.query<{ id: number; tx: string }>(
    `SELECT series_id AS id, transaction_id::text AS tx FROM recurring_exclusions`,
  );
  const dismissed = await db.query<{ key: string }>(`SELECT group_key AS key FROM recurring_dismissed`);
  return {
    series: series.rows,
    rows: rows.rows,
    pauses: byId(pauses.rows.map((p) => ({ id: p.id, value: { from: p.from, until: p.until } }))),
    skips: byId(skips.rows.map((s) => ({ id: s.id, value: s.due }))),
    excluded: byId(excluded.rows.map((e) => ({ id: e.id, value: e.tx }))),
    dismissed: dismissed.rows.map((d) => d.key),
  };
}

export type CreateResult =
  | { created: number }
  | { already: number; name: string }
  | { missing: true }
  | { taken: true }
  | { invalid: true };

/**
 * A series made from one saved transaction, and that transaction linked to
 * it, in one statement. Its match keys come from the transaction: an
 * expense's merchant and largest line's subcategory, an income's source, a
 * transfer's accounts. A transaction already in a series (a second tap)
 * creates nothing and names that series.
 */
export async function createSeries(input: {
  transactionId: string;
  name: string;
  cadence: Cadence;
  amountVaries: boolean;
}): Promise<CreateResult> {
  const db = await getPool();
  try {
    const res = await db.query<{ created: number | null; already: number | null; name: string | null }>(
      `WITH t AS (
         SELECT t.id, t.type, t.recurring_series_id, t.merchant_id, t.income_source_id,
                t.from_account_id, t.to_account_id, ${DOMINANT_SUBCATEGORY("t")} AS subcategory_id
         FROM transactions t WHERE t.id = $1::uuid FOR UPDATE
       ),
       ins AS (
         INSERT INTO recurring_series (name, kind, cadence, amount_varies, merchant_id, subcategory_id,
                                       income_source_id, from_account_id, to_account_id)
         SELECT $2::text, t.type, $3::recurring_cadence, $4::boolean,
                CASE WHEN t.type = 'expense' THEN t.merchant_id END,
                CASE WHEN t.type = 'expense' THEN t.subcategory_id END,
                CASE WHEN t.type = 'income' THEN t.income_source_id END,
                CASE WHEN t.type = 'transfer' THEN t.from_account_id END,
                CASE WHEN t.type = 'transfer' THEN t.to_account_id END
         FROM t WHERE t.recurring_series_id IS NULL
         RETURNING id
       ),
       link AS (
         UPDATE transactions x SET recurring_series_id = ins.id FROM ins WHERE x.id = $1::uuid RETURNING x.id
       )
       SELECT (SELECT id FROM ins) AS created, t.recurring_series_id AS already,
              (SELECT s.name FROM recurring_series s WHERE s.id = t.recurring_series_id) AS name
       FROM t`,
      [input.transactionId, input.name, input.cadence, input.amountVaries],
    );
    const row = res.rows[0];
    if (!row) return { missing: true };
    if (row.created !== null) return { created: row.created };
    if (row.name !== null) return { already: row.already!, name: row.name };
    // A concurrent tap linked it after this statement's snapshot, so the
    // series that tap made is visible only to a new statement.
    const named = await db.query<{ name: string }>("SELECT name FROM recurring_series WHERE id = $1", [row.already]);
    return { already: row.already!, name: named.rows[0]?.name ?? "another series" };
  } catch (err) {
    if (hasCode(err, "23505")) return { taken: true };
    // A check on recurring_series: an income with no source, a transfer with no accounts.
    if (hasCode(err, "23514")) return { invalid: true };
    throw err;
  }
}

/**
 * A dated pause [from, until), until null = until resumed. The same pause
 * again (a second tap) is "already"; one overlapping another pause of the
 * series is refused by the exclusion constraint and writes nothing.
 */
export async function pauseSeries(
  seriesId: number,
  from: string,
  until: string | null,
): Promise<"paused" | "already" | "overlap" | "missing"> {
  const db = await getPool();
  const SAME = `SELECT 1 FROM recurring_pauses
                WHERE series_id = $1 AND paused_from = $2::date AND resumed_on IS NOT DISTINCT FROM $3::date`;
  try {
    const res = await db.query(
      `INSERT INTO recurring_pauses (series_id, paused_from, resumed_on)
       SELECT $1, $2::date, $3::date WHERE NOT EXISTS (${SAME})`,
      [seriesId, from, until],
    );
    return res.rowCount ? "paused" : "already";
  } catch (err) {
    // A concurrent identical tap that committed first is a repeat, not an overlap.
    if (hasCode(err, "23P01")) return (await db.query(SAME, [seriesId, from, until])).rowCount ? "already" : "overlap";
    if (hasCode(err, "23503")) return "missing";
    throw err;
  }
}

/**
 * Ends the pause that covers `on`: it resumes that day, or disappears when it
 * began that day. False when no pause covers it (already resumed).
 */
export async function resumeSeries(seriesId: number, on: string): Promise<boolean> {
  const db = await getPool();
  const res = await db.query<{ n: number }>(
    `WITH p AS (
       SELECT id, paused_from FROM recurring_pauses
       WHERE series_id = $1 AND paused_from <= $2::date AND (resumed_on IS NULL OR resumed_on > $2::date)
       FOR UPDATE
     ),
     gone AS (DELETE FROM recurring_pauses WHERE id IN (SELECT id FROM p WHERE paused_from = $2::date) RETURNING 1),
     ended AS (
       UPDATE recurring_pauses SET resumed_on = $2::date
       WHERE id IN (SELECT id FROM p WHERE paused_from < $2::date) RETURNING 1
     )
     SELECT ((SELECT count(*) FROM gone) + (SELECT count(*) FROM ended))::int AS n`,
    [seriesId, on],
  );
  return res.rows[0].n > 0;
}

export async function renameSeries(seriesId: number, name: string): Promise<"renamed" | "taken" | "missing"> {
  const db = await getPool();
  try {
    const res = await db.query(`UPDATE recurring_series SET name = $2 WHERE id = $1`, [seriesId, name]);
    return res.rowCount ? "renamed" : "missing";
  } catch (err) {
    if (hasCode(err, "23505")) return "taken";
    throw err;
  }
}

/**
 * Deletes a series. Its payments stay saved; the foreign key unlinks them and
 * the trigger clears their is_recurring. Null when it was already deleted.
 */
export async function deleteSeries(seriesId: number): Promise<{ name: string; unlinked: number } | null> {
  const db = await getPool();
  // The count reads the statement's snapshot, from before the unlink.
  const res = await db.query<{ name: string; unlinked: number }>(
    `WITH d AS (DELETE FROM recurring_series WHERE id = $1 RETURNING name)
     SELECT d.name, (SELECT count(*)::int FROM transactions WHERE recurring_series_id = $1) AS unlinked FROM d`,
    [seriesId],
  );
  return res.rows[0] ?? null;
}

/**
 * Applies a review page: links each `link` id that is still in no series and
 * still has the series' kind and hard key (income source, accounts), clears
 * any exclusion it had, and records an exclusion for each `ignore` id not in
 * this series, so it is never offered to it again. Null when the series is
 * gone. Repeating it links and ignores nothing new.
 */
export async function applyReview(
  seriesId: number,
  link: string[],
  ignore: string[],
): Promise<{ linked: number; ignored: number } | null> {
  const db = await getPool();
  const res = await db.query<{ linked: number; ignored: number }>(
    `WITH s AS (SELECT * FROM recurring_series WHERE id = $1 FOR UPDATE),
     linked AS (
       UPDATE transactions t SET recurring_series_id = s.id
       FROM s
       WHERE t.id = ANY($2::uuid[]) AND t.recurring_series_id IS NULL AND t.type = s.kind
         AND (s.kind <> 'income' OR t.income_source_id = s.income_source_id)
         AND (s.kind <> 'transfer' OR (t.from_account_id IS NOT DISTINCT FROM s.from_account_id
                                       AND t.to_account_id IS NOT DISTINCT FROM s.to_account_id))
       RETURNING t.id
     ),
     unexcluded AS (
       DELETE FROM recurring_exclusions e USING linked l
       WHERE e.series_id = $1 AND e.transaction_id = l.id RETURNING 1
     ),
     ignored AS (
       INSERT INTO recurring_exclusions (series_id, transaction_id)
       SELECT s.id, t.id FROM s JOIN transactions t ON t.id = ANY($3::uuid[])
       WHERE t.recurring_series_id IS DISTINCT FROM s.id
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT (SELECT count(*)::int FROM linked) AS linked, (SELECT count(*)::int FROM ignored) AS ignored
     FROM s`,
    [seriesId, link, ignore],
  );
  return res.rows[0] ?? null;
}

/** Clears the legacy is_recurring flag of picked rows that are in no series; how many it cleared. */
export async function clearFlags(transactionIds: string[]): Promise<number> {
  const db = await getPool();
  const res = await db.query(
    `UPDATE transactions SET is_recurring = false
     WHERE id = ANY($1::uuid[]) AND recurring_series_id IS NULL AND is_recurring`,
    [transactionIds],
  );
  return res.rowCount ?? 0;
}

/** Records a detector proposal the owner answered "not recurring"; false when it already was. */
export async function dismissGroup(groupKey: string): Promise<boolean> {
  const db = await getPool();
  const res = await db.query(
    `INSERT INTO recurring_dismissed (group_key) VALUES ($1) ON CONFLICT DO NOTHING`,
    [groupKey],
  );
  return Boolean(res.rowCount);
}
