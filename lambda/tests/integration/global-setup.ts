import { readdirSync, readFileSync } from "node:fs";
import { Client } from "pg";
import { TEST_DB, adminUrl, testDbUrl } from "./env.js";

const SUPABASE = new URL("../../../supabase/", import.meta.url);

export default async function setup(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  // Roles are cluster-wide: migration 0003 creates it again.
  await admin.query("DROP ROLE IF EXISTS finflow_readonly");
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const db = new Client({ connectionString: testDbUrl() });
  await db.connect();
  const dir = new URL("migrations/", SUPABASE);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    try {
      await db.query(readFileSync(new URL(file, dir), "utf8"));
    } catch (err) {
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
  await db.query(
    readFileSync(new URL("seed.personal.example.sql", SUPABASE), "utf8"),
  );
  await db.end();
}
