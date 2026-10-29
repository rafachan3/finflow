// The one-off media-merchant backfill (entry: backfill-media-merchant.ts).
// Re-reads the archived photo or voice note of a confirmed ingestion whose
// extraction named no merchant, asks Gemini only which businesses it names, and
// stores the one it names in ingestions.media_merchant for /addmerchant to link on.
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { collapseSpaces, MERCHANT_NAME_MAX, merchantKey } from "../src/commands.js";
import { generateJson } from "../src/gemini.js";
import { mimeTypeForPath } from "../src/telegram.js";

export type Candidate = { id: string; source: "photo" | "voice"; media_path: string };

type Querier = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * Confirmed photo or voice rows with archived media, no extraction merchant and
 * no media_merchant yet, that are their message's only saved event. A message
 * with several events is skipped: its media may name another event's business.
 * An event that failed validation was never saved, so the only row left is not
 * proof of a single event: it must also be event 0 (so an earlier event was
 * not dropped), and media naming more than one business is skipped (a later
 * event may have been).
 */
const CANDIDATES = `
  SELECT i.id::text, i.source, i.media_path
  FROM ingestions i
  WHERE i.status = 'confirmed'
    AND i.source IN ('photo', 'voice')
    AND i.media_path IS NOT NULL
    AND i.media_merchant IS NULL
    AND i.event_index = 0
    AND coalesce(btrim(i.extraction->>'merchant'), '') = ''
    AND NOT EXISTS (
      SELECT 1 FROM ingestions o
      WHERE o.telegram_update_id = i.telegram_update_id AND o.id <> i.id
    )
  ORDER BY i.created_at
  LIMIT $1`;

const SYSTEM =
  "You read one receipt photo or voice note about one or more purchases. Return every business it names: each store, restaurant or company printed on the receipt or spoken in the note, spelled as printed or said, once each. Return an empty list when no business is named. Do not guess a business from the items.";

const QUESTION = "Which businesses does this name? An empty list if none.";

const SCHEMA = {
  type: "OBJECT",
  properties: { merchants: { type: "ARRAY", items: { type: "STRING" } } },
  required: ["merchants"],
};

async function readMedia(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await out.Body!.transformToByteArray());
}

/** The distinct businesses the media names, through the extraction's client and model fallback. */
async function askMerchants(apiKey: string, bytes: Buffer, mimeType: string): Promise<string[]> {
  const { data } = await generateJson({
    apiKey,
    system: SYSTEM,
    userParts: [{ inlineData: { mimeType, data: bytes.toString("base64") } }, { text: QUESTION }],
    schema: SCHEMA,
  });
  const said = (data as { merchants?: unknown }).merchants;
  const names = new Map<string, string>();
  for (const raw of Array.isArray(said) ? said : []) {
    const name = typeof raw === "string" ? collapseSpaces(raw) : "";
    if (name !== "" && !names.has(merchantKey(name))) names.set(merchantKey(name), name);
  }
  return [...names.values()];
}

/** Why a named business is not stored, or null when it is the one to store. */
function skipReason(names: string[]): string | null {
  if (names.length > 1) return `names several (${names.join("; ")})`;
  if (names[0].length > MERCHANT_NAME_MAX) return `name over ${MERCHANT_NAME_MAX} characters`;
  return null;
}

export async function backfillMediaMerchants(opts: {
  db: Querier;
  s3: S3Client;
  bucket: string;
  apiKey: string;
  dryRun: boolean;
  limit: number | null;
  log: (line: string) => void;
}): Promise<{ candidates: number; named: number; written: number; skipped: number; failed: number }> {
  const rows = (await opts.db.query(CANDIDATES, [opts.limit])).rows as Candidate[];
  let named = 0;
  let written = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const label = `${row.id.slice(0, 8)} ${row.source}`;
    try {
      const bytes = await readMedia(opts.s3, opts.bucket, row.media_path);
      const names = await askMerchants(opts.apiKey, bytes, mimeTypeForPath(row.media_path));
      if (names.length === 0) {
        opts.log(`${label}: (none)`);
        continue;
      }
      const skip = skipReason(names);
      if (skip !== null) {
        skipped++;
        opts.log(`${label}: skipped, ${skip}`);
        continue;
      }
      opts.log(`${label}: ${names[0]}`);
      named++;
      if (opts.dryRun) continue;
      // Re-checked here so a concurrent run never overwrites an answer.
      await opts.db.query(
        "UPDATE ingestions SET media_merchant = $2 WHERE id = $1 AND media_merchant IS NULL",
        [row.id, names[0]],
      );
      written++;
    } catch (err) {
      failed++;
      opts.log(`${label} failed: ${(err as Error).message}`);
    }
  }
  const dry = opts.dryRun ? " (dry run: nothing written)" : "";
  opts.log(
    `${rows.length} candidates, ${named} named, ${written} written, ${skipped} skipped, ${failed} failed${dry}`,
  );
  return { candidates: rows.length, named, written, skipped, failed };
}

export function parseArgs(argv: string[]): { dryRun: boolean; limit: number | null } {
  let dryRun = false;
  let limit: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") {
      dryRun = true;
    } else if (argv[i] === "--limit") {
      limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit needs a whole number of at least 1");
    } else {
      throw new Error(`unknown argument ${argv[i]} (use --dry-run, --limit N)`);
    }
  }
  return { dryRun, limit };
}
