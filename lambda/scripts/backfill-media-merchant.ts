// One-off, run by hand against production; never in CI or the Lambda. Fills
// ingestions.media_merchant from the archived media (see media-merchant.ts).
// Reads its secrets from SSM the way the Lambda does and prints none of them.
//
//   RECEIPTS_BUCKET=finflow-receipts-$(aws sts get-caller-identity --query Account --output text) \
//   AWS_REGION=ca-central-1 npm run backfill:media-merchant -- --dry-run [--limit N]
//
// Without --dry-run it writes. A row already set is skipped, so a re-run only
// retries the rows that failed or named no business.
import { S3Client } from "@aws-sdk/client-s3";
import { Pool } from "pg";
import { getConfig } from "../src/config.js";
import { backfillMediaMerchants, parseArgs } from "./media-merchant.js";

const args = parseArgs(process.argv.slice(2));
const config = await getConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
try {
  const result = await backfillMediaMerchants({
    db: pool,
    s3: new S3Client({}),
    bucket: config.receiptsBucket,
    apiKey: config.geminiApiKey,
    ...args,
    log: (line) => console.log(line),
  });
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
