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

import { putReceipt } from "../src/s3.js";

describe("putReceipt", () => {
  afterEach(() => {
    send.mockReset();
  });

  it("puts the JPEG at {ingestionId}.jpg and returns that key", async () => {
    send.mockResolvedValue({});
    const body = Buffer.from([0xff, 0xd8, 0xff]);

    const key = await putReceipt({
      bucket: "finflow-receipts-test",
      ingestionId: "11111111-1111-1111-1111-111111111111",
      body,
      contentType: "image/jpeg",
    });

    expect(key).toBe("11111111-1111-1111-1111-111111111111.jpg");
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({
      Bucket: "finflow-receipts-test",
      Key: key,
      Body: body,
      ContentType: "image/jpeg",
    });
  });

  it("puts a PNG at {ingestionId}.png when contentType is image/png", async () => {
    send.mockResolvedValue({});
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const key = await putReceipt({
      bucket: "finflow-receipts-test",
      ingestionId: "11111111-1111-1111-1111-111111111111",
      body,
      contentType: "image/png",
    });

    expect(key).toBe("11111111-1111-1111-1111-111111111111.png");
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(command.input.Key).toBe(key);
    expect(command.input.ContentType).toBe("image/png");
  });
});
