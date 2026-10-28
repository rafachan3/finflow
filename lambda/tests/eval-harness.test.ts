import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureAnswer,
  isRelevant,
  outageWaiter,
  recordedFile,
  retryOnce,
  shouldRun,
} from "../eval/harness.js";

describe("isRelevant", () => {
  it.each([
    "lambda/src/gemini.ts",
    "lambda/tests/golden/two-stores.json",
    "lambda/tests/golden/media/receipt.png",
    "lambda/eval/harness.ts",
    "supabase/migrations/0009_new.sql",
    "supabase/seed.personal.example.sql",
  ])("%s changes what Gemini is asked or how it is judged", (path) => {
    expect(isRelevant(["README.md", path])).toBe(true);
  });

  it("ignores docs, journeys, infra and workflows", () => {
    expect(
      isRelevant([
        "docs/STATUS.md",
        "lambda/tests/journeys/edit.test.ts",
        "lambda/tests/golden.test.ts",
        "infra/main.tf",
        ".github/workflows/ci.yml",
        "lambda/src-old/x.ts",
      ]),
    ).toBe(false);
  });
});

describe("shouldRun", () => {
  const diff = (paths: string[]) => () => paths;

  it("runs when a relevant path changed since the base", () => {
    expect(shouldRun("abc123", diff(["lambda/src/handler.ts"])).run).toBe(true);
  });

  it("skips when nothing relevant changed", () => {
    const scope = shouldRun("abc123", diff(["docs/STATUS.md"]));
    expect(scope).toEqual({ run: false, why: "no extraction, prompt, golden or eval path changed" });
  });

  it("passes the base to the diff", () => {
    const seen: string[] = [];
    shouldRun("abc123", (base) => (seen.push(base), []));
    expect(seen).toEqual(["abc123"]);
  });

  it.each([undefined, "", "0000000000000000000000000000000000000000"])(
    "runs everything when the base is %j (local run or a new branch)",
    (base) => {
      expect(shouldRun(base, diff([])).run).toBe(true);
    },
  );

  it("runs everything when the diff fails", () => {
    const scope = shouldRun("abc123", () => {
      throw new Error("bad revision");
    });
    expect(scope.run).toBe(true);
    expect(scope.why).toContain("bad revision");
  });
});

describe("outageWaiter", () => {
  const overloaded = () => new Error("Gemini HTTP 503: The model is overloaded.");

  function fakeClock() {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => void slept.push(ms) };
  }

  it("waits and retries while every model is overloaded or out of quota", async () => {
    const clock = fakeClock();
    const wait = outageWaiter({ budgetMs: 20 * 60_000, everyMs: 2 * 60_000, sleep: clock.sleep });
    const errors = [overloaded(), new Error("Gemini HTTP 429: quota")];
    const result = await wait(async () => {
      const err = errors.shift();
      if (err) throw err;
      return "answer";
    });
    expect(result).toBe("answer");
    expect(clock.slept).toEqual([120_000, 120_000]);
  });

  it("gives up once the budget is spent, across every call that shares it", async () => {
    const clock = fakeClock();
    const wait = outageWaiter({ budgetMs: 5 * 60_000, everyMs: 2 * 60_000, sleep: clock.sleep });
    await expect(wait(async () => Promise.reject(overloaded()))).rejects.toThrow(
      "Gemini HTTP 503",
    );
    expect(clock.slept).toEqual([120_000, 120_000]);
    // The next case gets no fresh 20 minutes: one outage bounds the whole run.
    await expect(wait(async () => Promise.reject(overloaded()))).rejects.toThrow();
    expect(clock.slept).toHaveLength(2);
  });

  it("does not wait on errors that are not an outage", async () => {
    const clock = fakeClock();
    const wait = outageWaiter({ budgetMs: 60_000, everyMs: 1_000, sleep: clock.sleep });
    for (const message of ["Gemini HTTP 400: bad schema", "Gemini returned no events"]) {
      await expect(wait(async () => Promise.reject(new Error(message)))).rejects.toThrow(message);
    }
    expect(clock.slept).toEqual([]);
  });
});

describe("retryOnce", () => {
  it("passes on the first clean answer without a second call", async () => {
    const attempt = vi.fn(async () => [] as string[]);
    expect(await retryOnce(attempt)).toEqual([]);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("accepts a clean second answer", async () => {
    const answers = [["event 0: 2 lines != 1"], []];
    expect(await retryOnce(async () => answers.shift()!)).toEqual([]);
  });

  it("fails with the second answer's problems when both miss", async () => {
    const answers = [["first"], ["second"]];
    expect(await retryOnce(async () => answers.shift()!)).toEqual(["second"]);
  });

  it("turns a thrown error into a problem and retries", async () => {
    const attempt = vi.fn(async (): Promise<string[]> => {
      throw new Error("Gemini returned no events");
    });
    expect(await retryOnce(attempt)).toEqual(["Gemini returned no events"]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe("recordedFile", () => {
  const text = readFileSync(new URL("./golden/no-date-text.json", import.meta.url), "utf8");
  const golden = JSON.parse(text);
  const live = {
    events: [{ ...golden.recorded.events[0], description: "Coffee, live" }],
  };

  it("rewrites only `recorded`, in the file's own format", () => {
    const next = recordedFile(text, live);
    expect(next).not.toBeNull();
    expect(JSON.parse(next!)).toEqual({ ...golden, recorded: live });
    expect(next!.endsWith("}\n")).toBe(true);
    expect(recordedFile(text, golden.recorded)).toBe(text);
  });

  it("refuses an answer that breaks the expectation", () => {
    const twoLines = {
      events: [{ ...live.events[0], items: [...live.events[0].items, { amount: "0.00" }] }],
    };
    expect(recordedFile(text, twoLines)).toBeNull();
    expect(recordedFile(text, { events: [] })).toBeNull();
  });

  it("records an edit as the single patched extraction", () => {
    const editText = readFileSync(new URL("./golden/edit-amount.json", import.meta.url), "utf8");
    const edit = JSON.parse(editText);
    expect(recordedFile(editText, edit.recorded)).toBe(editText);
    expect(recordedFile(editText, { events: [edit.recorded] })).toBeNull();
  });
});

describe("captureAnswer", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function gemini(status: number, data: unknown): Response {
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] }),
      { status },
    );
  }

  it("returns the first successful Gemini answer, not the bucket call after it", async () => {
    const replies = [
      new Response("overloaded", { status: 503 }),
      gemini(200, { events: ["extract"] }),
      gemini(200, { buckets: ["bucket"] }),
    ];
    const fake = (async () => replies.shift()!) as typeof fetch;
    globalThis.fetch = fake;
    const bodies: unknown[] = [];

    const raw = await captureAnswer(async () => {
      for (let i = 0; i < 3; i++) {
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/m:generateContent");
        bodies.push(await res.text());
      }
    });

    expect(raw).toEqual({ events: ["extract"] });
    // The production code still reads every body.
    expect(bodies).toHaveLength(3);
    expect(globalThis.fetch).toBe(fake);
  });

  it("puts fetch back even when the call throws", async () => {
    const before = globalThis.fetch;
    await expect(
      captureAnswer(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(globalThis.fetch).toBe(before);
  });
});
