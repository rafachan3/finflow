import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discardKeyboard,
  downloadTelegramFile,
  largestPhotoFileId,
  reviewKeyboard,
  voiceFileId,
} from "../src/telegram.js";

describe("reviewKeyboard", () => {
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("puts Confirm and Discard on the first row and Fix date and Edit on the second", () => {
    expect(reviewKeyboard(id)).toEqual({
      inline_keyboard: [
        [
          { text: "Confirm", callback_data: `c:${id}` },
          { text: "Discard", callback_data: `d:${id}` },
        ],
        [
          { text: "Fix date", callback_data: `f:${id}` },
          { text: "Edit", callback_data: `e:${id}` },
        ],
      ],
    });
  });

  it("omits Confirm but keeps Edit when confirm is false", () => {
    expect(reviewKeyboard(id, { confirm: false })).toEqual({
      inline_keyboard: [
        [{ text: "Discard", callback_data: `d:${id}` }],
        [
          { text: "Fix date", callback_data: `f:${id}` },
          { text: "Edit", callback_data: `e:${id}` },
        ],
      ],
    });
  });

  it("omits Edit when edit is false", () => {
    expect(reviewKeyboard(id, { confirm: false, edit: false })).toEqual({
      inline_keyboard: [
        [{ text: "Discard", callback_data: `d:${id}` }],
        [{ text: "Fix date", callback_data: `f:${id}` }],
      ],
    });
  });
});

describe("discardKeyboard", () => {
  it("is Discard only", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(discardKeyboard(id)).toEqual({
      inline_keyboard: [[{ text: "Discard", callback_data: `d:${id}` }]],
    });
  });
});

describe("largestPhotoFileId", () => {
  it("picks the photo size with the greatest file_size", () => {
    expect(
      largestPhotoFileId([
        { file_id: "small", file_size: 10 },
        { file_id: "big", file_size: 99 },
        { file_id: "mid", file_size: 40 },
      ]),
    ).toBe("big");
  });

  it("uses the last size when file_size is missing", () => {
    expect(
      largestPhotoFileId([{ file_id: "a" }, { file_id: "b" }]),
    ).toBe("b");
  });

  it("throws when there is no file_id", () => {
    expect(() => largestPhotoFileId([])).toThrow(/no photo file_id/i);
  });
});

describe("voiceFileId", () => {
  it("returns file_id from a voice object", () => {
    expect(voiceFileId({ file_id: "AwACAg", duration: 3 })).toBe("AwACAg");
  });

  it("throws when file_id is missing", () => {
    expect(() => voiceFileId({})).toThrow(/no voice file_id/i);
  });
});

describe("downloadTelegramFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets file_path then downloads bytes from the file URL", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { file_path: "photos/x.jpg" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => jpeg.buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const file = await downloadTelegramFile("tok", "file-id-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.telegram.org/bottok/getFile",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ file_id: "file-id-1" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/file/bottok/photos/x.jpg",
    );
    expect(file.bytes.equals(Buffer.from(jpeg))).toBe(true);
    expect(file.mimeType).toBe("image/jpeg");
  });

  it("treats a .oga voice path as audio/ogg", async () => {
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { file_path: "voice/file_1.oga" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => ogg.buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const file = await downloadTelegramFile("tok", "voice-id");

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.org/file/bottok/voice/file_1.oga",
    );
    expect(file.bytes.equals(Buffer.from(ogg))).toBe(true);
    expect(file.mimeType).toBe("audio/ogg");
  });

  it("treats a .ogg path as audio/ogg", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          result: { file_path: "voice/file_2.ogg" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const file = await downloadTelegramFile("tok", "voice-id");
    expect(file.mimeType).toBe("audio/ogg");
  });

  it("throws when getFile is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, description: "file not found" }),
      }),
    );

    await expect(downloadTelegramFile("tok", "missing")).rejects.toThrow(
      /getFile/i,
    );
  });
});
