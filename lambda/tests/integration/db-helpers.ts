import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { testDbUrl } from "./env.js";

const pool = new Pool({ connectionString: testDbUrl(), max: 2 });

export async function sql<T extends QueryResultRow = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await pool.query<T>(text, params)).rows;
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    await client.query("RESET ROLE").catch(() => {});
    client.release();
  }
}

/** The merchants the example seed overlay ships. */
const SEED_MERCHANTS = ["Acme Mart", "Example Online"];

/** Empties the data tables; taxonomy and lookup tables keep their seed. */
export async function resetData(): Promise<void> {
  await pool.query(
    "TRUNCATE ingestions, transaction_tags, transaction_items, transactions, recurring_series, recurring_dismissed RESTART IDENTITY CASCADE",
  );
  // Merchant commands change the lookup, so put it back as seeded.
  await pool.query("DELETE FROM merchants WHERE name <> ALL($1)", [SEED_MERCHANTS]);
  await pool.query("UPDATE merchants SET hidden_at = NULL WHERE hidden_at IS NOT NULL");
  await pool.query(
    "INSERT INTO merchants (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING",
    [SEED_MERCHANTS],
  );
}

export type TxSeed = {
  date: string;
  amount: string;
  description: string;
  type?: "expense" | "income" | "transfer";
  merchant?: string;
  /** An income's source. */
  source?: string;
  /** A transfer's accounts; null is chequing. */
  from?: string;
  to?: string;
  /** An expense's one line; Groceries by default. */
  subcategory?: string;
  /** A legacy is_recurring flag, as the Notion import or Gemini's guess left it. */
  flagged?: boolean;
};

/** A saved transaction as a history import writes it (no ingestion); an expense gets one line. Its id. */
export async function insertTransaction(t: TxSeed): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `WITH t AS (
       INSERT INTO transactions (occurred_on, type, amount, description, merchant_id, income_source_id,
                                 from_account_id, to_account_id, funding_source_id, is_recurring)
       VALUES ($1::date, $2::transaction_type, $3::numeric, $4,
               (SELECT id FROM merchants WHERE name = $5), (SELECT id FROM income_sources WHERE name = $6),
               (SELECT id FROM accounts WHERE name = $7), (SELECT id FROM accounts WHERE name = $8),
               CASE WHEN $2 = 'expense' THEN (SELECT id FROM funding_sources WHERE name = 'self') END, $9)
       RETURNING id, type, amount, description
     ),
     line AS (
       INSERT INTO transaction_items (transaction_id, description, amount, subcategory_id, bucket)
       SELECT t.id, t.description, t.amount, s.id, 'needs' FROM t JOIN subcategories s ON s.name = $10
       WHERE t.type = 'expense'
     )
     SELECT id::text FROM t`,
    [
      t.date,
      t.type ?? "expense",
      t.amount,
      t.description,
      t.merchant ?? null,
      t.source ?? null,
      t.from ?? null,
      t.to ?? null,
      t.flagged ?? false,
      t.subcategory ?? "Groceries",
    ],
  );
  return row.id;
}

export async function closeHelpers(): Promise<void> {
  await pool.end();
}
