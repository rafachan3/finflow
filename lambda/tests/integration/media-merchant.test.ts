import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillMediaMerchants } from "../../scripts/media-merchant.js";
import type { PendingIngestion } from "../../src/db.js";
import { closeHelpers, resetData, sql } from "./db-helpers.js";
import { expense, pending } from "./fixtures.js";

vi.mock("../../src/config.js", async () => {
  const { testDbUrl } = await import("./env.js");
  return { getConfig: async () => ({ databaseUrl: testDbUrl() }) };
});

const db = await import("../../src/db.js");
const s3 = mockClient(S3Client);

afterAll(async () => {
  s3.restore();
  await db.closePool();
  await closeHelpers();
});
beforeEach(async () => {
  await resetData();
  s3.reset();
  s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => new Uint8Array([1]) } } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"merchant":"Maple Kiosk"}' }] } }] }),
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Saves one message's events from `source` with archived media, then confirms the first `confirm`. */
async function message(
  updateId: number,
  source: PendingIngestion["source"],
  merchants: (string | null)[],
  confirm = merchants.length,
): Promise<string[]> {
  const rows = merchants.map((merchant, i) => ({
    ...pending(updateId, expense({ merchant }), i, source === "text" ? null : `${updateId}.jpg`),
    source,
  }));
  const ids = await db.insertPendingIngestions(rows);
  if (ids === "duplicate") throw new Error("unexpected duplicate");
  for (const { id } of ids.slice(0, confirm)) await db.confirmIngestion(id);
  return ids.map((r) => r.id);
}

async function mediaMerchants(): Promise<Record<string, string | null>> {
  const rows = await sql<{ id: string; media_merchant: string | null }>(
    "select id::text, media_merchant from ingestions",
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.media_merchant]));
}

function backfill(dryRun = false) {
  return backfillMediaMerchants({
    db: { query: async (text: string, values?: unknown[]) => ({ rows: await sql(text, values) }) },
    s3: new S3Client({}),
    bucket: "receipts",
    apiKey: "test-key",
    dryRun,
    limit: null,
    log: () => {},
  });
}

describe("media merchant backfill candidates", () => {
  it("reads only confirmed single-event photos and voice notes with no merchant, once", async () => {
    const [photo] = await message(1, "photo", [null]);
    const [voice] = await message(2, "voice", [""]);
    const [named] = await message(3, "photo", ["Acme Mart"]);
    const [unconfirmed] = await message(4, "photo", [null], 0);
    const [text] = await message(5, "text", [null]);
    const twoEvents = await message(6, "photo", [null, null]);

    expect(await backfill(true)).toEqual({ candidates: 2, named: 2, written: 0, failed: 0 });
    expect(Object.values(await mediaMerchants()).every((m) => m === null)).toBe(true);

    expect(await backfill()).toEqual({ candidates: 2, named: 2, written: 2, failed: 0 });
    expect(await mediaMerchants()).toEqual({
      [photo]: "Maple Kiosk",
      [voice]: "Maple Kiosk",
      [named]: null,
      [unconfirmed]: null,
      [text]: null,
      [twoEvents[0]]: null,
      [twoEvents[1]]: null,
    });
    expect(s3.commandCalls(GetObjectCommand).map((c) => c.args[0].input.Key)).toEqual([
      "1.jpg", "2.jpg", "1.jpg", "2.jpg",
    ]);

    expect(await backfill()).toEqual({ candidates: 0, named: 0, written: 0, failed: 0 });
  });
});
