// The one-off media-merchant backfill (entry: backfill-media-merchant.ts).
// Re-reads the archived photo or voice note of a confirmed ingestion whose
// extraction named no merchant, asks Gemini only which business it names, and
// stores the answer in ingestions.media_merchant for /addmerchant to link on.
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { collapseSpaces } from "../src/commands.js";
import { generateJson } from "../src/gemini.js";
import { mimeTypeForPath } from "../src/telegram.js";

export type Candidate = { id: string; source: "photo" | "voice"; media_path: string };

type Querier = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

/**
 * Confirmed photo or voice rows with archived media, no extraction merchant and
 * no media_merchant yet. A message that produced several events is skipped: its
 * media names one business, which may not be this event's (a caption purchase
 * elsewhere, or a second place in one voice note).
 */
const CANDIDATES = `
  SELECT i.id::text, i.source, i.media_path
  FROM ingestions i
  WHERE i.status = 'confirmed'
    AND i.source IN ('photo', 'voice')
    AND i.media_path IS NOT NULL
    AND i.media_merchant IS NULL
    AND coalesce(btrim(i.extraction->>'merchant'), '') = ''
    AND NOT EXISTS (
      SELECT 1 FROM ingestions o
      WHERE o.telegram_update_id = i.telegram_update_id AND o.id <> i.id
    )
  ORDER BY i.created_at
  LIMIT $1`;

const SYSTEM =
  "You read one receipt photo or voice note about a purchase. Return the business it names: the store, restaurant or company printed on the receipt or spoken in the note, spelled as printed or said. Return null when no business is named. Do not guess a business from the items.";

const QUESTION = "Which business does this name? null if none.";

const SCHEMA = {
  type: "OBJECT",
  properties: { merchant: { type: "STRING", nullable: true } },
  required: ["merchant"],
};

async function readMedia(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await out.Body!.transformToByteArray());
}

/** The business the media names, through the extraction's client and model fallback. */
async function askMerchant(apiKey: string, bytes: Buffer, mimeType: string): Promise<string | null> {
  const { data } = await generateJson({
    apiKey,
    system: SYSTEM,
    userParts: [{ inlineData: { mimeType, data: bytes.toString("base64") } }, { text: QUESTION }],
    schema: SCHEMA,
  });
  const merchant = (data as { merchant?: unknown }).merchant;
  const name = typeof merchant === "string" ? collapseSpaces(merchant) : "";
  return name === "" ? null : name;
}

export async function backfillMediaMerchants(opts: {
  db: Querier;
  s3: S3Client;
  bucket: string;
  apiKey: string;
  dryRun: boolean;
  limit: number | null;
  log: (line: string) => void;
}): Promise<{ candidates: number; named: number; written: number; failed: number }> {
  const rows = (await opts.db.query(CANDIDATES, [opts.limit])).rows as Candidate[];
  let named = 0;
  let written = 0;
  let failed = 0;
  for (const row of rows) {
    const label = `${row.id.slice(0, 8)} ${row.source}`;
    try {
      const bytes = await readMedia(opts.s3, opts.bucket, row.media_path);
      const name = await askMerchant(opts.apiKey, bytes, mimeTypeForPath(row.media_path));
      opts.log(`${label}: ${name ?? "(none)"}`);
      if (name === null) continue;
      named++;
      if (opts.dryRun) continue;
      // Re-checked here so a concurrent run never overwrites an answer.
      await opts.db.query(
        "UPDATE ingestions SET media_merchant = $2 WHERE id = $1 AND media_merchant IS NULL",
        [row.id, name],
      );
      written++;
    } catch (err) {
      failed++;
      opts.log(`${label} failed: ${(err as Error).message}`);
    }
  }
  const dry = opts.dryRun ? " (dry run: nothing written)" : "";
  opts.log(`${rows.length} candidates, ${named} named, ${written} written, ${failed} failed${dry}`);
  return { candidates: rows.length, named, written, failed };
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
