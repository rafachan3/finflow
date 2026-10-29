import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands.js";

describe("parseCommand", () => {
  it("reads a known slash command with or without @botname, in any case, and its argument", () => {
    expect(parseCommand("/pending")).toEqual({ name: "pending", args: "" });
    expect(parseCommand("  /Pending@any_bot ")).toEqual({ name: "pending", args: "" });
    expect(parseCommand("/pending@any_bot now")).toEqual({ name: "pending", args: "now" });
  });

  it("returns nothing for plain text, an unknown command, or a longer word", () => {
    expect(parseCommand("12.50 lunch")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("/pending5")).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });
});
