import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryWait } from "../src/gemini.js";
import {
  backfillMediaMerchants,
  parseArgs,
  type Candidate,
} from "../scripts/media-merchant.js";

const s3 = mockClient(S3Client);

function media(bytes: string) {
  return { Body: { transformToByteArray: async () => new TextEncoder().encode(bytes) } } as never;
}

function geminiSays(...merchants: (string | null)[]) {
  const fetchMock = vi.fn();
  for (const merchant of merchants) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ merchant }) }] } }],
      }),
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A database that lists `rows` as candidates and records every write. */
function fakeDb(rows: Candidate[]) {
  const writes: unknown[][] = [];
  const selects: unknown[][] = [];
  return {
    writes,
    selects,
    async query(text: string, values: unknown[] = []) {
      if (/^\s*UPDATE/i.test(text)) {
        writes.push(values);
        return { rows: [] };
      }
      selects.push(values);
      return { rows };
    },
  };
}

const photo: Candidate = { id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: "photo", media_path: "1111.jpg" };
const voice: Candidate = { id: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", source: "voice", media_path: "2222.ogg" };

function run(db: ReturnType<typeof fakeDb>, over: { dryRun?: boolean; limit?: number | null } = {}) {
  const lines: string[] = [];
  const done = backfillMediaMerchants({
    db,
    s3: new S3Client({}),
    bucket: "receipts",
    apiKey: "test-key",
    dryRun: over.dryRun ?? false,
    limit: over.limit ?? null,
    log: (line) => lines.push(line),
  });
  return { done, lines };
}

beforeEach(() => {
  s3.reset();
  retryWait.sleep = async () => {};
});
afterEach(() => vi.unstubAllGlobals());

describe("media merchant backfill", () => {
  it("asks Gemini only which business the media names, with the media inline, and stores the answer", async () => {
    s3.on(GetObjectCommand, { Key: "1111.jpg" }).resolves(media("jpeg"));
    s3.on(GetObjectCommand, { Key: "2222.ogg" }).resolves(media("ogg"));
    const fetchMock = geminiSays("  Maple   Kiosk ", null);
    const db = fakeDb([photo, voice]);

    const { done, lines } = run(db);
    expect(await done).toEqual({ candidates: 2, named: 1, written: 1, failed: 0 });

    expect(s3.commandCalls(GetObjectCommand).map((c) => c.args[0].input)).toEqual([
      { Bucket: "receipts", Key: "1111.jpg" },
      { Bucket: "receipts", Key: "2222.ogg" },
    ]);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
    expect(bodies[0].contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: Buffer.from("jpeg").toString("base64") } },
      { text: "Which business does this name? null if none." },
    ]);
    expect(bodies[1].contents[0].parts[0].inlineData.mimeType).toBe("audio/ogg");
    expect(Object.keys(bodies[0].generationConfig.responseSchema.properties)).toEqual(["merchant"]);
    expect(bodies[0].systemInstruction.parts[0].text).not.toMatch(/Subcategories|Merchants:/);
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe("test-key");

    expect(db.writes).toEqual([[photo.id, "Maple Kiosk"]]);
    expect(lines).toEqual([
      "11111111 photo: Maple Kiosk",
      "22222222 voice: (none)",
      "2 candidates, 1 named, 1 written, 0 failed",
    ]);
  });

  it("a dry run reads and prints the proposed names but writes nothing", async () => {
    s3.on(GetObjectCommand).resolves(media("jpeg"));
    geminiSays("Maple Kiosk");
    const db = fakeDb([photo]);

    const { done, lines } = run(db, { dryRun: true });
    expect(await done).toEqual({ candidates: 1, named: 1, written: 0, failed: 0 });
    expect(db.writes).toEqual([]);
    expect(lines.at(-1)).toBe("1 candidates, 1 named, 0 written, 0 failed (dry run: nothing written)");
  });

  it("passes the limit to the candidate query, and no limit as null", async () => {
    const db = fakeDb([]);
    expect(await run(db, { limit: 3 }).done).toEqual({ candidates: 0, named: 0, written: 0, failed: 0 });
    await run(db).done;
    expect(db.selects).toEqual([[3], [null]]);
  });

  it("counts a missing object or a Gemini error as failed, writes nothing for it, and goes on", async () => {
    s3.on(GetObjectCommand, { Key: "1111.jpg" }).rejects(new NoSuchKey({ message: "gone", $metadata: {} }));
    s3.on(GetObjectCommand, { Key: "2222.ogg" }).resolves(media("ogg"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "bad audio" } }) }),
    );
    const db = fakeDb([photo, voice]);

    const { done, lines } = run(db);
    expect(await done).toEqual({ candidates: 2, named: 0, written: 0, failed: 2 });
    expect(db.writes).toEqual([]);
    expect(lines).toEqual([
      "11111111 photo failed: gone",
      "22222222 voice failed: Gemini HTTP 400: bad audio",
      "2 candidates, 0 named, 0 written, 2 failed",
    ]);
  });

  it("treats a blank or non-text answer as no business", async () => {
    s3.on(GetObjectCommand).resolves(media("jpeg"));
    geminiSays("   ", 42 as never);
    const db = fakeDb([photo, { ...photo, id: "33333333-cccc-4ccc-8ccc-cccccccccccc" }]);
    expect(await run(db).done).toEqual({ candidates: 2, named: 0, written: 0, failed: 0 });
    expect(db.writes).toEqual([]);
  });

  it("reads --dry-run and --limit N, and refuses anything else", () => {
    expect(parseArgs([])).toEqual({ dryRun: false, limit: null });
    expect(parseArgs(["--dry-run", "--limit", "5"])).toEqual({ dryRun: true, limit: 5 });
    expect(() => parseArgs(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseArgs(["--limit"])).toThrow(/--limit/);
    expect(() => parseArgs(["--write"])).toThrow(/--write/);
  });
});
