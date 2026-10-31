import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, commandMenu } from "../src/commands.js";
import {
  registerCommandMenu,
  discardKeyboard,
  downloadTelegramFile,
  editMessageReplyMarkup,
  editMessageText,
  esc,
  largestPhotoFileId,
  reviewKeyboard,
  sendMessage,
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

describe("command menu", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists exactly the commands the handler routes on, in Telegram's allowed shape", () => {
    expect(commandMenu().map((c) => c.command)).toEqual(Object.keys(COMMANDS));
    for (const { command, description } of commandMenu()) {
      expect(COMMANDS[command as keyof typeof COMMANDS]).toBe(description);
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThanOrEqual(3);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it("registers that menu with setMyCommands", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await registerCommandMenu("TOKEN");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN/setMyCommands");
    expect(JSON.parse(init.body)).toEqual({ commands: commandMenu() });
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

describe("message edits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function telegramSays400(description: string) {
    const body = JSON.stringify({ ok: false, error_code: 400, description });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => body }));
  }

  it("treats Telegram's 'message is not modified' as done, so a retried tap does not fail", async () => {
    telegramSays400(
      "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
    );
    await expect(editMessageReplyMarkup("tok", 1, 2, { inline_keyboard: [] })).resolves.toBeUndefined();
    await expect(editMessageText("tok", 1, 2, "Linked 1 of 2 to Maple Kiosk.")).resolves.toBeUndefined();
  });

  it("sends HTML with link previews off and keeps the buttons an edit passes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const keyboard = [[{ text: "Back", callback_data: "r:l:0" }]];

    await sendMessage("tok", 1, "<b>Hi</b>", { inline_keyboard: keyboard }, { html: true });
    await editMessageText("tok", 1, 2, "<b>Hi</b>", keyboard, { html: true });
    await sendMessage("tok", 1, "plain");

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    const html = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
    expect(bodies[0]).toEqual({ chat_id: 1, text: "<b>Hi</b>", ...html, reply_markup: { inline_keyboard: keyboard } });
    expect(bodies[1]).toEqual({ chat_id: 1, message_id: 2, text: "<b>Hi</b>", ...html, reply_markup: { inline_keyboard: keyboard } });
    expect(bodies[2]).toEqual({ chat_id: 1, text: "plain" });
  });

  it("escapes &, < and > for an HTML message", () => {
    expect(esc("Tom & Jerry <3 > 2")).toBe("Tom &amp; Jerry &lt;3 &gt; 2");
  });

  it("still throws any other refused edit", async () => {
    telegramSays400("Bad Request: message to edit not found");
    await expect(editMessageReplyMarkup("tok", 1, 2, { inline_keyboard: [] })).rejects.toThrow(/not found/);
    await expect(editMessageText("tok", 1, 2, "x")).rejects.toThrow(/not found/);
  });
});
