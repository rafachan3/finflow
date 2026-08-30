import { Pool, type PoolClient } from "pg";
import { getConfig } from "./config.js";
import {
  fundingSourceToPersist,
  validateExtraction,
  type Extraction,
  type TaxonomySnapshot,
} from "./extraction.js";

let pool: Pool | undefined;

async function getPool(): Promise<Pool> {
  if (!pool) {
    const { databaseUrl } = await getConfig();
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  }
  return pool;
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
    `SELECT name FROM merchants ORDER BY name`,
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

export async function insertPendingIngestion(args: {
  id?: string;
  source?: "text" | "photo" | "voice";
  mediaPath?: string | null;
  telegramUpdateId: number;
  rawPayload: unknown;
  extraction: Extraction;
}): Promise<{ id: string } | "duplicate"> {
  const db = await getPool();
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO ingestions (id, source, telegram_update_id, raw_payload, extraction, status, media_path)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5::jsonb, 'pending', $6)
       RETURNING id`,
      [
        args.id ?? null,
        args.source ?? "text",
        args.telegramUpdateId,
        JSON.stringify(args.rawPayload),
        JSON.stringify(args.extraction),
        args.mediaPath ?? null,
      ],
    );
    return { id: result.rows[0].id };
  } catch (err) {
    if (isUniqueViolation(err)) return "duplicate";
    throw err;
  }
}

export async function discardIngestion(
  ingestionId: string,
): Promise<"discarded" | "already_handled"> {
  const db = await getPool();
  const result = await db.query(
    `UPDATE ingestions SET status = 'discarded'
     WHERE id = $1 AND status IN ('pending', 'awaiting_date')`,
    [ingestionId],
  );
  return !result.rowCount ? "already_handled" : "discarded";
}

export async function findAwaitingDateIngestion(): Promise<{
  id: string;
  extraction: Extraction;
} | null> {
  const db = await getPool();
  const result = await db.query<{ id: string; extraction: Extraction }>(
    `SELECT id, extraction FROM ingestions
     WHERE status = 'awaiting_date'
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export async function setIngestionAwaitingDate(
  ingestionId: string,
): Promise<boolean> {
  const db = await getPool();
  const result = await db.query(
    `UPDATE ingestions SET status = 'awaiting_date'
     WHERE id = $1 AND status = 'pending'`,
    [ingestionId],
  );
  return Boolean(result.rowCount);
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
            `SELECT id FROM merchants WHERE name = $1`,
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
         funding_source_id, is_recurring
       ) VALUES ($1, $2, $3, 'CAD', $4, $5, $6, $7, $8, $9, $10)
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
