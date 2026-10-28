// `npm run eval:buckets [-- --sample N --seed S --rules PATH --detail --dry-run]`
// Local only, never in CI: replays the owner's hand-set buckets through
// production's text extraction with the private rules. See docs/TESTING.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { Client } from "pg";
import { loadTaxonomy } from "../src/db.js";
import type { Extraction } from "../src/extraction.js";
import { extractFromText, GEMINI_FALLBACK_MODEL, GEMINI_LITE_MODEL, GEMINI_MODEL } from "../src/gemini.js";
import { todayToronto } from "../src/handler.js";
import {
  compareLines,
  geminiKey,
  messageFor,
  parseArgs,
  readonlyUrl,
  report,
  sample,
  type BucketCase,
  type TruthTx,
} from "./buckets.js";
import { captureAnswer, geminiFetch } from "./harness.js";

const LAMBDA = dirname(dirname(fileURLToPath(import.meta.url)));
// The main checkout, so a worktree finds the untracked files there too.
const ROOT = dirname(
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: LAMBDA,
    encoding: "utf8",
  }).trim(),
);
const ENV_FILE = join(ROOT, ".env");
const DETAIL_DIR = join(LAMBDA, ".eval-buckets");
// Same spacing as the golden eval: under 5 requests a minute.
const MIN_GAP_MS = 13_000;

// Notion-imported expenses: no ingestion was confirmed into them, so the
// owner chose every bucket. Bot rows only had Gemini's bucket confirmed.
const TRUTH_SQL = `
  SELECT t.id, t.occurred_on::text, t.amount::text, t.description, t.notes,
         m.name AS merchant, v.name AS venue, f.name AS funded_by,
         coalesce(array_agg(tg.name ORDER BY tg.name) FILTER (WHERE tg.name IS NOT NULL), '{}') AS tags
  FROM transactions t
  JOIN funding_sources f ON f.id = t.funding_source_id
  LEFT JOIN merchants m ON m.id = t.merchant_id
  LEFT JOIN venues v ON v.id = t.venue_id
  LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
  LEFT JOIN tags tg ON tg.id = tt.tag_id
  WHERE t.type = 'expense'
    AND NOT EXISTS (SELECT 1 FROM ingestions i WHERE i.transaction_id = t.id)
  GROUP BY t.id, m.name, v.name, f.name
  ORDER BY t.id`;

const LINES_SQL = `
  SELECT ti.transaction_id, ti.description, ti.amount::text, c.name AS category,
         s.name AS subcategory, ti.bucket
  FROM transaction_items ti
  JOIN subcategories s ON s.id = ti.subcategory_id
  JOIN categories c ON c.id = s.category_id
  WHERE ti.transaction_id = ANY($1)
  ORDER BY ti.transaction_id, ti.amount DESC, ti.description`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), join(ROOT, "docs/BUCKET_RULES.local.md"));
  } catch (err) {
    fail((err as Error).message);
  }
  if (!existsSync(args.rules)) fail(`bucket rules not found at ${args.rules} (pass --rules PATH)`);
  const rules = readFileSync(args.rules, "utf8");
  const envFile = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  let apiKey = "";
  if (!args.dryRun) {
    try {
      apiKey = geminiKey(process.env, envFile, ENV_FILE);
    } catch (err) {
      fail((err as Error).message);
    }
  }
  const password = process.env.FINFLOW_READONLY_PASSWORD || envFile.FINFLOW_READONLY_PASSWORD;
  if (!password) fail(`FINFLOW_READONLY_PASSWORD is not set in the environment or ${ENV_FILE}`);
  const poolerFile = join(ROOT, "supabase/.temp/pooler-url");
  if (!existsSync(poolerFile)) fail(`no pooler URL at ${poolerFile} (run supabase link)`);

  // Verified TLS: the pooler's chain ends in Supabase's own root CA (public,
  // from Supabase's download bucket), which the system store lacks.
  const db = new Client({
    connectionString: readonlyUrl(readFileSync(poolerFile, "utf8"), password),
    ssl: { ca: readFileSync(join(LAMBDA, "../supabase/prod-ca-2021.crt"), "utf8") },
  });
  await db.connect();
  let picked: TruthTx[];
  let taxonomy;
  try {
    // The role can only read; this makes the session say so too.
    await db.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const txs = (await db.query(TRUTH_SQL)).rows;
    picked = sample(txs, args.sample, args.seed);
    const lines = (await db.query(LINES_SQL, [picked.map((t) => t.id)])).rows;
    picked = picked.map((t) => ({ ...t, lines: lines.filter((l) => l.transaction_id === t.id) }));
    taxonomy = await loadTaxonomy(db);
    console.log(`${txs.length} owner-labelled expenses; sampled ${picked.length} with seed ${args.seed}`);
  } finally {
    await db.end();
  }

  if (args.dryRun) {
    for (const t of picked) console.log(messageFor(t));
    return;
  }

  globalThis.fetch = geminiFetch(globalThis.fetch, {
    models: [GEMINI_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_LITE_MODEL],
    minGapMs: MIN_GAP_MS,
    now: Date.now,
    sleep,
  });
  const cases: BucketCase[] = [];
  for (const [i, tx] of picked.entries()) {
    const message = messageFor(tx);
    let events: Extraction[] = [];
    let model: string | undefined;
    let error: string | undefined;
    try {
      ({ model } = await captureAnswer(async () => {
        events = await extractFromText({ apiKey, text: message, taxonomy, bucketRules: rules, today: todayToronto() });
      }));
    } catch (err) {
      error = (err as Error).message;
    }
    cases.push({ tx, message, model, error, lines: compareLines(tx, events) });
    console.log(`case ${i + 1}/${picked.length}: answered by ${model ?? `no model (${error})`}`);
    if (error?.includes("daily quota exhausted on every model")) break;
  }

  console.log(`\n${report(cases)}`);
  if (args.detail) {
    mkdirSync(DETAIL_DIR, { recursive: true });
    const file = join(DETAIL_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, `${JSON.stringify({ args: { ...args, rules: undefined }, cases }, null, 2)}\n`);
    console.log(`detail: ${file}`);
  }
}

await main();
