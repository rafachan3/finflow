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
    "TRUNCATE ingestions, transaction_tags, transaction_items, transactions RESTART IDENTITY CASCADE",
  );
  // Merchant commands change the lookup, so put it back as seeded.
  await pool.query("DELETE FROM merchants WHERE name <> ALL($1)", [SEED_MERCHANTS]);
  await pool.query(
    "INSERT INTO merchants (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING",
    [SEED_MERCHANTS],
  );
}

export async function closeHelpers(): Promise<void> {
  await pool.end();
}
