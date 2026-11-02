import { describe, expect, it } from "vitest";
import { runDateOf } from "../src/nudge.js";

describe("runDateOf", () => {
  it("is the Toronto day of the scheduled time, on either side of daylight time, else of now", () => {
    expect(runDateOf({ scheduled_time: "2026-10-31T13:00:00Z" })).toBe("2026-10-31");
    expect(runDateOf({ scheduled_time: "2026-11-02T14:00:00Z" })).toBe("2026-11-02");
    // 00:30 UTC is still the evening before in Toronto.
    expect(runDateOf({ scheduled_time: "2026-11-03T00:30:00Z" })).toBe("2026-11-02");
    const now = new Date("2026-12-01T15:00:00Z");
    expect(runDateOf({}, now)).toBe("2026-12-01");
    expect(runDateOf({ scheduled_time: "not a time" }, now)).toBe("2026-12-01");
    expect(runDateOf(undefined, now)).toBe("2026-12-01");
  });
});
