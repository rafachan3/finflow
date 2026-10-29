import { Pool, type PoolClient } from "pg";
import { APOSTROPHE_VARIANTS } from "./commands.js";
import { getConfig } from "./config.js";
import {
  fundingSourceToPersist,
  validateExtraction,
  type DuplicateMatch,
  type Extraction,
  type TaxonomySnapshot,
} from "./extraction.js";
import { mentionPattern, MENTIONS_PAGE, type Mention } from "./mentions.js";

let pool: Pool | undefined;

async function getPool(): Promise<Pool> {
  if (!pool) {
    const { databaseUrl } = await getConfig();
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  }
  return pool;
}

/** Ends the pool; the next query opens a new one. */
export async function closePool(): Promise<void> {
  const open = pool;
  pool = undefined;
  await open?.end();
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

type Querier = { query: Pool["query"] };

export async function loadTaxonomy(
  db?: Querier,
): Promise<TaxonomySnapshot> {
  const q = db ?? (await getPool());
  // Sequential: a PoolClient cannot safely run Promise.all on one connection.
  const subs = await q.query<{
    category: string;
    name: string;
    default_bucket: "needs" | "wants" | null;
  }>(
    `SELECT c.name AS category, s.name, s.default_bucket
     FROM subcategories s
     JOIN categories c ON c.id = s.category_id
     ORDER BY c.name, s.name`,
  );
  const types = await q.query<{ category: string; name: string }>(
    `SELECT c.name AS category, t.name
     FROM item_types t
     JOIN categories c ON c.id = t.category_id
     ORDER BY c.name, t.name`,
  );
  const venues = await q.query<{ name: string }>(
    `SELECT name FROM venues ORDER BY name`,
  );
  const tags = await q.query<{ name: string }>(
    `SELECT name FROM tags ORDER BY name`,
  );
  const funding = await q.query<{ name: string }>(
    `SELECT name FROM funding_sources ORDER BY name`,
  );
  const merchants = await q.query<{ name: string }>(
    `SELECT name FROM merchants WHERE hidden_at IS NULL ORDER BY name`,
  );
  const income = await q.query<{ name: string }>(
    `SELECT name FROM income_sources ORDER BY name`,
  );
  const accounts = await q.query<{ name: string }>(
    `SELECT name FROM accounts ORDER BY name`,
  );

  return {
    subcategories: subs.rows,
    itemTypes: types.rows,
    venues: venues.rows.map((r) => r.name),
    tags: tags.rows.map((r) => r.name),
    fundingSources: funding.rows.map((r) => r.name),
    merchants: merchants.rows.map((r) => r.name),
    incomeSources: income.rows.map((r) => r.name),
    accounts: accounts.rows.map((r) => r.name),
  };
}

/** The merchants the prompt offers, and how many are hidden. */
export async function listMerchants(): Promise<{ names: string[]; hidden: number }> {
  const db = await getPool();
  const res = await db.query<{ name: string; hidden: boolean }>(
    `SELECT name, hidden_at IS NOT NULL AS hidden FROM merchants ORDER BY name`,
  );
  return {
    names: res.rows.filter((r) => !r.hidden).map((r) => r.name),
    hidden: res.rows.filter((r) => r.hidden).length,
  };
}

/** A merchant name as the lookups compare it: spaces collapsed, ends trimmed. */
const MERCHANT_SPACED = (name: string) => `btrim(regexp_replace(${name}, '\\s+', ' ', 'g'))`;
/**
 * The same, ignoring case and apostrophe style: spellings with one key are one
 * merchant. commands.ts's merchantKey is this rule in TypeScript.
 */
export const MERCHANT_KEY = (name: string) =>
  `lower(translate(${MERCHANT_SPACED(name)}, '${APOSTROPHE_VARIANTS}', '${"''".repeat(APOSTROPHE_VARIANTS.length)}'))`;

/**
 * Adds a merchant, unhides one with that name, or finds it already visible; then
 * links the saved transactions with no merchant that name it. A bot-saved
 * transaction names it in its stored extraction or in what a re-read of its
 * archived media found (media_merchant); a history import has no ingestion, so
 * its whole description must be the name. The unique constraint is
 * case-sensitive, so a name matching in another case or apostrophe is matched here.
 */
export async function addMerchant(
  name: string,
): Promise<
  { id: number; added: string; unhid: boolean; linked: number } | { id: number; exists: string; linked: number }
> {
  const db = await getPool();
  // One statement: insert unless a merchant matches by key; unhide that one if it is
  // hidden. Whichever merchant results only ever fills a NULL merchant_id.
  const res = await db.query<{ id: number; name: string; kind: string; linked: number }>(
    `WITH m AS (
       SELECT id, name, hidden_at FROM merchants
       WHERE ${MERCHANT_KEY("name")} = ${MERCHANT_KEY("$1::text")} FOR UPDATE
     ),
     ins AS (
       INSERT INTO merchants (name)
       SELECT $1::text WHERE NOT EXISTS (SELECT 1 FROM m)
       RETURNING id, name
     ),
     unhid AS (
       UPDATE merchants SET hidden_at = NULL
       WHERE id IN (SELECT id FROM m WHERE hidden_at IS NOT NULL)
       RETURNING id, name
     ),
     target AS (
       SELECT id, name, 'added' AS kind FROM ins
       UNION ALL
       SELECT id, name, 'unhid' FROM unhid
       UNION ALL
       SELECT id, name, 'exists' FROM m WHERE hidden_at IS NULL
     ),
     linked AS (
       UPDATE transactions t SET merchant_id = target.id
       FROM target
       WHERE t.merchant_id IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM ingestions i
             WHERE i.transaction_id = t.id
               AND ${MERCHANT_KEY("target.name")} IN (
                 ${MERCHANT_KEY("i.extraction->>'merchant'")}, ${MERCHANT_KEY("i.media_merchant")}
               )
           )
           OR (
             NOT EXISTS (SELECT 1 FROM ingestions i WHERE i.transaction_id = t.id)
             AND ${MERCHANT_KEY("t.description")} = ${MERCHANT_KEY("target.name")}
           )
         )
       RETURNING t.id
     )
     SELECT id, name, kind, (SELECT count(*)::int FROM linked) AS linked FROM target`,
    [name],
  );
  const row = res.rows[0];
  return row.kind === "exists"
    ? { id: row.id, exists: row.name, linked: row.linked }
    : { id: row.id, added: row.name, unhid: row.kind === "unhid", linked: row.linked };
}

/**
 * Transactions with no merchant that mention a visible merchant as a whole word
 * or phrase (see mentionPattern) in their message text or caption, or in their
 * description: newest first, one page after the `after` transaction. Null when
 * the merchant is gone or hidden. Nothing is linked here.
 */
export async function findMentions(
  merchantId: number,
  after: string | null,
): Promise<{ name: string; total: number; rows: Mention[] } | null> {
  const db = await getPool();
  const merchant = await db.query<{ name: string }>(
    "SELECT name FROM merchants WHERE id = $1 AND hidden_at IS NULL",
    [merchantId],
  );
  const name = merchant.rows[0]?.name;
  if (name === undefined) return null;
  const res = await db.query<Mention & { total: number }>(
    `WITH hits AS (
       SELECT t.id, t.occurred_on, t.created_at, t.amount, t.description,
              (SELECT s.said
               FROM ingestions i,
                    LATERAL (SELECT coalesce(i.raw_payload #>> '{message,text}',
                                             i.raw_payload #>> '{message,caption}') AS said) s
               WHERE i.transaction_id = t.id AND ${MERCHANT_KEY("s.said")} ~ $1
               LIMIT 1) AS said
       FROM transactions t
       WHERE t.merchant_id IS NULL
         AND ($2::uuid IS NULL OR (t.occurred_on, t.created_at, t.id) <
              (SELECT occurred_on, created_at, id FROM transactions WHERE id = $2::uuid))
     )
     SELECT id::text, occurred_on::text AS date, amount::text, description, said,
            count(*) OVER ()::int AS total
     FROM hits
     WHERE said IS NOT NULL OR ${MERCHANT_KEY("description")} ~ $1
     ORDER BY occurred_on DESC, created_at DESC, id DESC
     LIMIT $3`,
    [mentionPattern(name), after, MENTIONS_PAGE],
  );
  return {
    name,
    total: res.rows[0]?.total ?? 0,
    rows: res.rows.map(({ id, date, amount, description, said }) => ({ id, date, amount, description, said })),
  };
}

/**
 * Links the picked transactions that still have no merchant to a visible
 * merchant. Null when it is gone or hidden; then nothing is written.
 */
export async function linkMentions(
  merchantId: number,
  transactionIds: string[],
): Promise<{ name: string; linked: number } | null> {
  const db = await getPool();
  const res = await db.query<{ name: string; linked: number }>(
    `WITH m AS (SELECT id, name FROM merchants WHERE id = $1 AND hidden_at IS NULL FOR UPDATE),
     linked AS (
       UPDATE transactions t SET merchant_id = m.id
       FROM m
       WHERE t.id = ANY($2::uuid[]) AND t.merchant_id IS NULL
       RETURNING t.id
     )
     SELECT name, (SELECT count(*)::int FROM linked) AS linked FROM m`,
    [merchantId, transactionIds],
  );
  return res.rows[0] ?? null;
}

/**
 * Deletes a merchant no transaction uses. One that transactions use is hidden
 * instead, so a delete never unlinks the ledger.
 */
export async function deleteMerchant(
  name: string,
): Promise<{ deleted: string } | { missing: true } | { hidden: string; uses: number }> {
  const db = await getPool();
  // One statement, so the count and the delete or hide share a snapshot and a row lock.
  // The foreign key still refuses the delete if a Confirm links the merchant after the count.
  const res = await db.query<{ name: string; n: number; deleted: boolean }>(
    `WITH m AS (
       SELECT id, name FROM merchants WHERE ${MERCHANT_KEY("name")} = ${MERCHANT_KEY("$1::text")} FOR UPDATE
     ),
     used AS (
       SELECT count(*)::int AS n FROM transactions WHERE merchant_id IN (SELECT id FROM m)
     ),
     del AS (
       DELETE FROM merchants
       WHERE id IN (SELECT id FROM m) AND (SELECT n FROM used) = 0
       RETURNING id
     ),
     hid AS (
       UPDATE merchants SET hidden_at = coalesce(hidden_at, now())
       WHERE id IN (SELECT id FROM m) AND (SELECT n FROM used) > 0
       RETURNING id
     )
     SELECT m.name, used.n, EXISTS (SELECT 1 FROM del) AS deleted FROM m, used`,
    [name],
  );
  const row = res.rows[0];
  if (!row) return { missing: true };
  return row.deleted ? { deleted: row.name } : { hidden: row.name, uses: row.n };
}

export type PendingIngestion = {
  id: string;
  source: "text" | "photo" | "voice";
  mediaPath: string | null;
  telegramUpdateId: number;
  eventIndex: number;
  rawPayload: unknown;
  extraction: Extraction;
};

/** All events of one update land together or not at all (retries → duplicate). */
export async function insertPendingIngestions(
  rows: PendingIngestion[],
): Promise<{ id: string }[] | "duplicate"> {
  if (rows.length === 0) return [];
  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // A retry re-runs Gemini and may save different event indexes, which the
    // unique key alone won't catch: serialise per update, then skip if saved.
    const updateId = rows[0].telegramUpdateId;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [updateId]);
    const seen = await client.query(
      "SELECT 1 FROM ingestions WHERE telegram_update_id = $1 LIMIT 1",
      [updateId],
    );
    if (seen.rowCount) {
      await client.query("ROLLBACK");
      return "duplicate";
    }
    const ids: { id: string }[] = [];
    for (const row of rows) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO ingestions (id, source, telegram_update_id, event_index, raw_payload, extraction, status, media_path)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending', $7)
         RETURNING id`,
        [
          row.id,
          row.source,
          row.telegramUpdateId,
          row.eventIndex,
          JSON.stringify(row.rawPayload),
          JSON.stringify(row.extraction),
          row.mediaPath,
        ],
      );
      ids.push({ id: result.rows[0].id });
    }
    await client.query("COMMIT");
    return ids;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  } finally {
    client.release();
  }
}

export async function discardIngestion(
  ingestionId: string,
): Promise<"discarded" | "already_handled"> {
  const db = await getPool();
  const result = await db.query(
    `UPDATE ingestions SET status = 'discarded'
     WHERE id = $1 AND status IN ('pending', 'awaiting_date', 'awaiting_edit')`,
    [ingestionId],
  );
  return !result.rowCount ? "already_handled" : "discarded";
}

export async function findAwaitingIngestion(): Promise<{
  id: string;
  extraction: Extraction;
  status: "awaiting_date" | "awaiting_edit";
} | null> {
  const db = await getPool();
  const result = await db.query<{
    id: string;
    extraction: Extraction;
    status: "awaiting_date" | "awaiting_edit";
  }>(
    `SELECT id, extraction, status FROM ingestions
     WHERE status IN ('awaiting_date', 'awaiting_edit')
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

/** Rows still waiting for Confirm or Discard, oldest first; the chat comes from the saved update. */
export async function listPendingIngestions(
  chatId: number,
): Promise<{ id: string; extraction: Extraction }[]> {
  const db = await getPool();
  const result = await db.query<{ id: string; extraction: Extraction }>(
    `SELECT id, extraction FROM ingestions
     WHERE status = 'pending' AND raw_payload #>> '{message,chat,id}' = $1
     ORDER BY created_at, event_index`,
    [String(chatId)],
  );
  return result.rows;
}

/** A card's day: its date, or the day it was sent when it has none yet. */
const CARD_DAY = (row: string) =>
  `coalesce(nullif(${row}.extraction->>'date', '')::date, (${row}.created_at AT TIME ZONE 'America/Toronto')::date)`;

/**
 * Likely earlier copies of a saved card, strongest first: an earlier card with
 * the same largest photo, then the same type and amount (and income source)
 * within 3 days among confirmed transactions and this chat's open cards,
 * nearest first, saved ahead of pending. Nothing from the card's own
 * Telegram update matches, so one message's events never flag each other.
 */
export async function findDuplicates(ingestionId: string): Promise<DuplicateMatch[]> {
  const db = await getPool();
  const result = await db.query<DuplicateMatch>(
    `WITH self AS (
       SELECT i.created_at, i.telegram_update_id,
              i.raw_payload #>> '{message,chat,id}' AS chat,
              i.extraction->>'type' AS type,
              (i.extraction->>'amount')::numeric AS amount,
              i.extraction->>'income_source' AS income_source,
              ${CARD_DAY("i")} AS day,
              CASE WHEN i.source = 'photo' THEN (
                SELECT p->>'file_unique_id'
                FROM jsonb_array_elements(i.raw_payload #> '{message,photo}') WITH ORDINALITY AS t(p, n)
                ORDER BY coalesce((p->>'file_size')::numeric, -1) DESC, n DESC
                LIMIT 1
              ) END AS photo_id
       FROM ingestions i WHERE i.id = $1
     ),
     others AS (
       SELECT o.*, ${CARD_DAY("o")} AS day
       FROM ingestions o, self s
       WHERE o.telegram_update_id <> s.telegram_update_id AND o.status <> 'discarded'
     ),
     matches AS (
       SELECT 'photo' AS rule,
              CASE WHEN o.status = 'confirmed' THEN 'saved' ELSE 'pending' END AS status,
              (o.created_at AT TIME ZONE 'America/Toronto')::date AS day,
              (o.extraction->>'amount')::numeric(12,2) AS amount,
              o.extraction->>'description' AS description,
              0 AS gap
       FROM others o, self s
       WHERE s.photo_id IS NOT NULL AND o.created_at < s.created_at
         AND o.raw_payload -> 'message' -> 'photo'
             @> jsonb_build_array(jsonb_build_object('file_unique_id', s.photo_id))
       UNION ALL
       SELECT 'amount', 'saved', t.occurred_on, t.amount, t.description,
              abs(t.occurred_on - s.day)
       FROM transactions t
       CROSS JOIN self s
       LEFT JOIN income_sources src ON src.id = t.income_source_id
       WHERE t.type::text = s.type AND t.amount = s.amount
         AND abs(t.occurred_on - s.day) <= 3
         AND (s.type <> 'income' OR src.name IS NOT DISTINCT FROM s.income_source)
         AND NOT EXISTS (
           SELECT 1 FROM ingestions x
           WHERE x.transaction_id = t.id AND x.telegram_update_id = s.telegram_update_id
         )
       UNION ALL
       SELECT 'amount', 'pending', o.day, (o.extraction->>'amount')::numeric(12,2),
              o.extraction->>'description', abs(o.day - s.day)
       FROM others o, self s
       WHERE o.status IN ('pending', 'awaiting_date', 'awaiting_edit')
         AND o.raw_payload #>> '{message,chat,id}' = s.chat
         AND o.extraction->>'type' = s.type
         AND (o.extraction->>'amount')::numeric = s.amount
         AND abs(o.day - s.day) <= 3
         AND (s.type <> 'income' OR o.extraction->>'income_source' IS NOT DISTINCT FROM s.income_source)
     )
     SELECT rule, status, day::text AS date, amount::text AS amount, description
     FROM matches
     ORDER BY rule = 'photo' DESC, gap, status = 'saved' DESC, day DESC`,
    [ingestionId],
  );
  return result.rows;
}

/**
 * The card's merchant when it is in no lookup row (visible or hidden, any case)
 * yet at least `min` other saved purchases name it: the owner may want to add
 * it. Saved means a confirmed ingestion of another Telegram update, and the
 * name is compared the way addMerchant links it.
 */
export async function findFrequentMerchant(
  ingestionId: string,
  min: number,
): Promise<{ name: string; count: number } | null> {
  const db = await getPool();
  const result = await db.query<{ name: string; count: number }>(
    `WITH self AS (
       SELECT i.telegram_update_id,
              ${MERCHANT_SPACED("i.extraction->>'merchant'")} AS name,
              ${MERCHANT_KEY("i.extraction->>'merchant'")} AS key
       FROM ingestions i WHERE i.id = $1
     )
     SELECT s.name, count(o.id)::int AS count
     FROM self s
     JOIN ingestions o
       ON o.status = 'confirmed'
      AND o.telegram_update_id <> s.telegram_update_id
      AND ${MERCHANT_KEY("o.extraction->>'merchant'")} = s.key
     WHERE s.key <> ''
       AND NOT EXISTS (SELECT 1 FROM merchants m WHERE ${MERCHANT_KEY("m.name")} = s.key)
     GROUP BY s.name
     HAVING count(o.id) >= $2`,
    [ingestionId, min],
  );
  return result.rows[0] ?? null;
}

export type AwaitStart = "started" | "already_handled" | "busy";

/** One outstanding wait: a reply is routed to the single waiting row. */
async function startAwaiting(
  ingestionId: string,
  status: "awaiting_date" | "awaiting_edit",
): Promise<AwaitStart> {
  const db = await getPool();
  const other = await db.query(
    `SELECT 1 FROM ingestions
     WHERE status IN ('awaiting_date', 'awaiting_edit') AND id <> $1
     LIMIT 1`,
    [ingestionId],
  );
  if (other.rowCount) return "busy";
  const result = await db.query(
    `UPDATE ingestions SET status = $2
     WHERE id = $1 AND status = 'pending'`,
    [ingestionId, status],
  );
  return result.rowCount ? "started" : "already_handled";
}

export async function setIngestionAwaitingDate(
  ingestionId: string,
): Promise<AwaitStart> {
  return startAwaiting(ingestionId, "awaiting_date");
}

export async function applyIngestionDate(
  ingestionId: string,
  extraction: Extraction,
): Promise<boolean> {
  const db = await getPool();
  const result = await db.query(
    `UPDATE ingestions
     SET extraction = $2::jsonb, status = 'pending'
     WHERE id = $1 AND status = 'awaiting_date'`,
    [ingestionId, JSON.stringify(extraction)],
  );
  return Boolean(result.rowCount);
}

export async function setIngestionAwaitingEdit(
  ingestionId: string,
): Promise<AwaitStart> {
  return startAwaiting(ingestionId, "awaiting_edit");
}

export async function applyIngestionEdit(
  ingestionId: string,
  extraction: Extraction,
): Promise<boolean> {
  const db = await getPool();
  const result = await db.query(
    `UPDATE ingestions
     SET extraction = $2::jsonb, status = 'pending'
     WHERE id = $1 AND status = 'awaiting_edit'`,
    [ingestionId, JSON.stringify(extraction)],
  );
  return Boolean(result.rowCount);
}

async function lookupId(
  client: PoolClient,
  sql: string,
  values: unknown[],
): Promise<number | null> {
  const res = await client.query<{ id: number }>(sql, values);
  return res.rows[0]?.id ?? null;
}

export async function confirmIngestion(
  ingestionId: string,
): Promise<"confirmed" | "already_handled"> {
  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const ing = await client.query<{
      id: string;
      status: string;
      extraction: Extraction;
    }>(
      `SELECT id, status, extraction FROM ingestions WHERE id = $1 FOR UPDATE`,
      [ingestionId],
    );

    if (!ing.rowCount || ing.rows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return "already_handled";
    }

    const extraction = ing.rows[0].extraction;
    const taxonomy = await loadTaxonomy(client);
    const checks = validateExtraction(extraction, taxonomy);
    if (!checks.ok) {
      await client.query("ROLLBACK");
      throw new Error(
        `Ingestion ${ingestionId} failed checks: ${checks.errors.join("; ")}`,
      );
    }

    const fundingName = fundingSourceToPersist(
      extraction.type,
      extraction.funded_by,
    );
    const fundingId =
      fundingName === null
        ? null
        : await lookupId(
            client,
            `SELECT id FROM funding_sources WHERE name = $1`,
            [fundingName],
          );
    if (extraction.type === "expense" && fundingId === null) {
      throw new Error(`funding source not found: ${extraction.funded_by}`);
    }

    const merchantId =
      extraction.merchant === null
        ? null
        : await lookupId(
            client,
            `SELECT id FROM merchants
             WHERE ${MERCHANT_KEY("name")} = ${MERCHANT_KEY("$1::text")} AND hidden_at IS NULL
             ORDER BY (name = $1::text) DESC, id LIMIT 1`,
            [extraction.merchant],
          );

    const venueId =
      extraction.venue === null
        ? null
        : await lookupId(
            client,
            `SELECT id FROM venues WHERE name = $1`,
            [extraction.venue],
          );

    const incomeSourceId =
      extraction.income_source === null
        ? null
        : await lookupId(
            client,
            `SELECT id FROM income_sources WHERE name = $1`,
            [extraction.income_source],
          );

    const toAccountId =
      extraction.to_account === null
        ? null
        : await lookupId(
            client,
            `SELECT id FROM accounts WHERE name = $1`,
            [extraction.to_account],
          );

    const tx = await client.query<{ id: string }>(
      `INSERT INTO transactions (
         occurred_on, type, amount, currency, description,
         merchant_id, venue_id, income_source_id, to_account_id,
         funding_source_id, is_recurring, notes
       ) VALUES ($1, $2, $3, 'CAD', $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        extraction.date,
        extraction.type,
        extraction.amount,
        extraction.description,
        merchantId,
        venueId,
        incomeSourceId,
        toAccountId,
        fundingId,
        extraction.is_recurring,
        extraction.notes ?? null,
      ],
    );
    const transactionId = tx.rows[0].id;

    if (extraction.type === "expense") {
      for (const item of extraction.items) {
        const sub = await client.query<{ id: number }>(
          `SELECT s.id
           FROM subcategories s
           JOIN categories c ON c.id = s.category_id
           WHERE c.name = $1 AND s.name = $2`,
          [item.category, item.subcategory],
        );
        if (!sub.rowCount) {
          throw new Error(
            `subcategory not found: ${item.category} / ${item.subcategory}`,
          );
        }
        let itemTypeId: number | null = null;
        if (item.item_type) {
          const it = await client.query<{ id: number }>(
            `SELECT t.id
             FROM item_types t
             JOIN categories c ON c.id = t.category_id
             WHERE c.name = $1 AND t.name = $2`,
            [item.category, item.item_type],
          );
          itemTypeId = it.rows[0]?.id ?? null;
        }
        await client.query(
          `INSERT INTO transaction_items (
             transaction_id, description, amount, subcategory_id, item_type_id, bucket
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            transactionId,
            item.description,
            item.amount,
            sub.rows[0].id,
            itemTypeId,
            item.bucket,
          ],
        );
      }
    }

    for (const tag of extraction.tags) {
      const tagId = await lookupId(
        client,
        `SELECT id FROM tags WHERE name = $1`,
        [tag],
      );
      if (tagId === null) continue;
      await client.query(
        `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
        [transactionId, tagId],
      );
    }

    await client.query(
      `UPDATE ingestions
       SET status = 'confirmed', transaction_id = $2
       WHERE id = $1`,
      [ingestionId, transactionId],
    );

    await client.query("COMMIT");
    return "confirmed";
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // already rolled back or connection broken
    }
    throw err;
  } finally {
    client.release();
  }
}
