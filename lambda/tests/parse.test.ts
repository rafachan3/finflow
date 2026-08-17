import { describe, expect, it } from "vitest";
import { parseQuickLog } from "../src/parse.js";

describe("parseQuickLog", () => {
  it("parses amount and description", () => {
    expect(parseQuickLog("12.50 lunch chipotle")).toEqual({
      amount: "12.50",
      description: "lunch chipotle",
      currency: "CAD",
    });
  });

  it("accepts comma decimal", () => {
    expect(parseQuickLog("9,99 coffee")).toEqual({
      amount: "9.99",
      description: "coffee",
      currency: "CAD",
    });
  });

  it("accepts integer amount", () => {
    expect(parseQuickLog("9 coffee")).toEqual({
      amount: "9.00",
      description: "coffee",
      currency: "CAD",
    });
  });

  it("returns null when description missing", () => {
    expect(parseQuickLog("12.50")).toBeNull();
  });

  it("returns null when no amount", () => {
    expect(parseQuickLog("lunch")).toBeNull();
  });
});
