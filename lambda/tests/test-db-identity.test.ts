import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script, no types
import { dbIdentity } from "../scripts/test-db.mjs";

describe("per-checkout test database identity", () => {
  it("is deterministic for a path", () => {
    expect(dbIdentity("/a/finflow")).toEqual(dbIdentity("/a/finflow"));
  });

  it("names the container and keeps the port in 54330-54429", () => {
    for (const p of ["/a", "/b/c", "/Users/x/finflow/.claude/worktrees/agent-1"]) {
      const { name, basePort } = dbIdentity(p);
      expect(name).toMatch(/^finflow-test-db-[0-9a-f]{8}$/);
      expect(basePort).toBeGreaterThanOrEqual(54330);
      expect(basePort).toBeLessThanOrEqual(54429);
    }
  });

  it("gives different checkouts different names", () => {
    expect(dbIdentity("/a").name).not.toBe(dbIdentity("/b").name);
  });
});
