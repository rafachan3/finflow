import { afterEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(command: unknown) {
      return send(command);
    }
  },
  PutObjectCommand: class PutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { mediaKey, putReceipt } from "../src/s3.js";

const ID = "11111111-1111-1111-1111-111111111111";

describe("mediaKey", () => {
  const base = { ingestionId: ID, contentType: "image/jpeg" };

  it("prefixes the source and the Toronto month", () => {
    const now = new Date("2026-10-15T12:00:00Z");
    expect(mediaKey({ ...base, source: "photo", now })).toBe(`photo/2026-10/${ID}.jpg`);
    expect(mediaKey({ ...base, source: "voice", contentType: "audio/ogg", now })).toBe(
      `voice/2026-10/${ID}.ogg`,
    );
  });

  it("uses Toronto's month across the UTC month boundary", () => {
    // 03:00Z on Nov 1 is 23:00 on Oct 31 in Toronto (EDT).
    expect(mediaKey({ ...base, source: "photo", now: new Date("2026-11-01T03:00:00Z") })).toBe(
      `photo/2026-10/${ID}.jpg`,
    );
    // 05:00Z on Nov 1 is 01:00 on Nov 1 in Toronto (still EDT until 2am Nov 1).
    expect(mediaKey({ ...base, source: "photo", now: new Date("2026-11-01T05:00:00Z") })).toBe(
      `photo/2026-11/${ID}.jpg`,
    );
  });
});

describe("putReceipt", () => {
  afterEach(() => {
    send.mockReset();
    vi.useRealTimers();
  });

  it("puts the JPEG at photo/{yyyy-mm}/{ingestionId}.jpg and returns that key", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T12:00:00Z") });
    send.mockResolvedValue({});
    const body = Buffer.from([0xff, 0xd8, 0xff]);

    const key = await putReceipt({
      bucket: "finflow-receipts-test",
      source: "photo",
      ingestionId: "11111111-1111-1111-1111-111111111111",
      body,
      contentType: "image/jpeg",
    });

    expect(key).toBe(`photo/2026-10/${ID}.jpg`);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      Bucket: "finflow-receipts-test",
      Key: key,
      Body: body,
      ContentType: "image/jpeg",
    });
  });

  it("puts a PNG at photo/{yyyy-mm}/{ingestionId}.png when contentType is image/png", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T12:00:00Z") });
    send.mockResolvedValue({});
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const key = await putReceipt({
      bucket: "finflow-receipts-test",
      source: "photo",
      ingestionId: "11111111-1111-1111-1111-111111111111",
      body,
      contentType: "image/png",
    });

    expect(key).toBe(`photo/2026-10/${ID}.png`);
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.Key).toBe(key);
    expect(command.input.ContentType).toBe("image/png");
  });

  it("puts Ogg audio at voice/{yyyy-mm}/{ingestionId}.ogg when contentType is audio/ogg", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T12:00:00Z") });
    send.mockResolvedValue({});
    const body = Buffer.from([0x4f, 0x67, 0x67, 0x53]);

    const key = await putReceipt({
      bucket: "finflow-receipts-test",
      source: "voice",
      ingestionId: "11111111-1111-1111-1111-111111111111",
      body,
      contentType: "audio/ogg",
    });

    expect(key).toBe(`voice/2026-10/${ID}.ogg`);
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      Bucket: "finflow-receipts-test",
      Key: key,
      Body: body,
      ContentType: "audio/ogg",
    });
  });
});
