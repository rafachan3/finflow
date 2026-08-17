import { Pool } from "pg";
import { getConfig } from "./config.js";
import type { QuickLog } from "./parse.js";

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

export async function insertPendingIngestion(args: {
  telegramUpdateId: number;
  rawPayload: unknown;
  extraction: QuickLog;
}): Promise<{ id: string } | "duplicate"> {
  const db = await getPool();
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO ingestions (source, telegram_update_id, raw_payload, extraction, status)
       VALUES ('text', $1, $2::jsonb, $3::jsonb, 'pending')
       RETURNING id`,
      [
        args.telegramUpdateId,
        JSON.stringify(args.rawPayload),
        JSON.stringify(args.extraction),
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
     WHERE id = $1 AND status = 'pending'`,
    [ingestionId],
  );
  return !result.rowCount ? "already_handled" : "discarded";
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
      extraction: QuickLog;
    }>(
      `SELECT id, status, extraction FROM ingestions WHERE id = $1 FOR UPDATE`,
      [ingestionId],
    );

    if (!ing.rowCount || ing.rows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return "already_handled";
    }

    const row = ing.rows[0];

    const extraction = row.extraction as QuickLog;
    if (
      !extraction ||
      typeof extraction.amount !== "string" ||
      typeof extraction.description !== "string"
    ) {
      await client.query("ROLLBACK");
      throw new Error(`Ingestion ${ingestionId} has invalid extraction`);
    }

    const funding = await client.query<{ id: number }>(
      `SELECT id FROM funding_sources WHERE name = 'self'`,
    );
    if (funding.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error("funding_sources row 'self' not found");
    }

    const subcat = await client.query<{ id: number }>(
      `SELECT id FROM subcategories WHERE name = 'Other personal'`,
    );
    if (subcat.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error("subcategories row 'Other personal' not found");
    }

    // ::text avoids node-pg Date parsing shifting the calendar day across TZ.
    const dateRes = await client.query<{ occurred_on: string }>(
      `SELECT (timezone('America/Toronto', now()))::date::text AS occurred_on`,
    );
    const occurredOn = dateRes.rows[0].occurred_on;

    const tx = await client.query<{ id: string }>(
      `INSERT INTO transactions (
         occurred_on, type, amount, currency, description,
         funding_source_id, is_recurring
       ) VALUES ($1, 'expense', $2, 'CAD', $3, $4, false)
       RETURNING id`,
      [
        occurredOn,
        extraction.amount,
        extraction.description,
        funding.rows[0].id,
      ],
    );
    const transactionId = tx.rows[0].id;

    await client.query(
      `INSERT INTO transaction_items (
         transaction_id, description, amount, subcategory_id, item_type_id, bucket
       ) VALUES ($1, $2, $3, $4, null, 'wants')`,
      [
        transactionId,
        extraction.description,
        extraction.amount,
        subcat.rows[0].id,
      ],
    );

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
