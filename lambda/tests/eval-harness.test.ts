import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureAnswer,
  geminiFetch,
  isRelevant,
  outageWaiter,
  recordedFile,
  retryOnce,
  shouldRun,
  summary,
} from "../eval/harness.js";

describe("isRelevant", () => {
  it.each([
    "lambda/src/gemini.ts",
    "lambda/tests/golden/two-stores.json",
    "lambda/tests/golden/media/receipt.png",
    "lambda/eval/harness.ts",
    "supabase/migrations/0009_new.sql",
    "supabase/seed.personal.example.sql",
    "lambda/tests/integration/global-setup.ts",
    "lambda/tests/integration/env.ts",
    "lambda/package.json",
    "lambda/package-lock.json",
    ".github/workflows/ci.yml",
  ])("%s changes what Gemini is asked or how it is judged", (path) => {
    expect(isRelevant(["README.md", path])).toBe(true);
  });

  it("ignores docs, journeys, infra and other workflows", () => {
    expect(
      isRelevant([
        "docs/STATUS.md",
        "lambda/tests/journeys/edit.test.ts",
        "lambda/tests/golden.test.ts",
        "lambda/tests/integration/db.test.ts",
        "infra/main.tf",
        ".github/workflows/deploy-ingest.yml",
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
  afterEach(() => vi.restoreAllMocks());

  it("passes on the first clean answer without a second call", async () => {
    const attempt = vi.fn(async () => [] as string[]);
    expect(await retryOnce("case", attempt)).toEqual({ problems: [], attempts: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("accepts a clean second answer, warning about the first", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers = [["event 0: 2 lines != 1"], []];
    expect(await retryOnce("two-stores", async () => answers.shift()!)).toEqual({
      problems: [],
      attempts: 2,
    });
    expect(warn).toHaveBeenCalledWith(
      "two-stores: attempt 1 failed (event 0: 2 lines != 1); retrying",
    );
  });

  it("fails with the second answer's problems when both miss", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const answers = [["first"], ["second"]];
    expect(await retryOnce("case", async () => answers.shift()!)).toEqual({
      problems: ["second"],
      attempts: 2,
    });
  });

  it("turns a thrown error into a problem and retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attempt = vi.fn(async (): Promise<string[]> => {
      throw new Error("Gemini returned no events");
    });
    expect((await retryOnce("case", attempt)).problems).toEqual(["Gemini returned no events"]);
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

    expect(raw).toEqual({ raw: { events: ["extract"] }, model: "m" });
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

describe("geminiFetch", () => {
  afterEach(() => vi.restoreAllMocks());
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";

  /** A clock that only moves when the code under test sleeps. */
  function fakeClock() {
    let t = 1_000_000;
    const slept: number[] = [];
    return {
      slept,
      now: () => t,
      sleep: async (ms: number) => void (slept.push(ms), (t += ms)),
      tick: (ms: number) => void (t += ms),
    };
  }

  function wrap(realFetch: typeof fetch, clock = fakeClock()) {
    return geminiFetch(realFetch, {
      models: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"],
      minGapMs: 13_000,
      now: clock.now,
      sleep: clock.sleep,
    });
  }

  function quota429(quotaId: string, quotaValue?: string): Response {
    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: "You exceeded your current quota.",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId, quotaValue }],
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "41s" },
          ],
        },
      }),
      { status: 429 },
    );
  }

  it("passes the request through untouched and logs model and status", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = new Response("{}", { status: 503 });
    const seen: unknown[] = [];
    const wrapped = wrap(async (...args) => (seen.push(...args), res));
    const init = { method: "POST", body: '{"exact":1}' };

    expect(await wrapped(url, init)).toBe(res);
    expect(seen[0]).toBe(url);
    expect(seen[1]).toBe(init);
    expect(log).toHaveBeenCalledWith("gemini-3.6-flash: HTTP 503");
  });

  it("keeps at least 13 s between the starts of Gemini requests", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = fakeClock();
    const wrapped = wrap(async () => new Response("{}"), clock);

    await wrapped(url);
    expect(clock.slept).toEqual([]);
    clock.tick(4_000);
    await wrapped(url);
    expect(clock.slept).toEqual([9_000]);
    clock.tick(20_000);
    await wrapped(url);
    expect(clock.slept).toEqual([9_000]);
  });

  it("logs a per-minute 429's quota and retry delay and leaves the body readable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const wrapped = wrap(async () => quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier"));

    const res = await wrapped(url);

    expect(log).toHaveBeenCalledWith(
      "gemini-3.6-flash: 429 quotaId=GenerateRequestsPerMinutePerProjectPerModel-FreeTier retryDelay=41s",
    );
    expect((await res.json()).error.code).toBe(429);
  });

  const urlOf = (model: string) => url.replace("gemini-3.6-flash", model);
  const perDay = () => quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "20");

  it("returns a per-day 429 so the chain moves on, then skips that model without calling it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const clock = fakeClock();
    const realFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).includes("gemini-3.6-flash") ? perDay() : new Response("{}"),
    );
    const wrapped = wrap(realFetch, clock);

    expect((await wrapped(url)).status).toBe(429);
    expect(log).toHaveBeenCalledWith(
      "gemini-3.6-flash: 429 quotaId=GenerateRequestsPerDayPerProjectPerModel-FreeTier retryDelay=41s limit=20",
    );
    clock.tick(60_000);
    const skipped = await wrapped(url);
    expect(skipped.status).toBe(429);
    expect((await skipped.json()).error.message).toMatch(/daily quota/);
    expect(clock.slept).toEqual([]);
    expect((await wrapped(urlOf("gemini-3.5-flash"))).status).toBe(200);
    expect(realFetch.mock.calls.map(([u]) => u)).toEqual([url, urlOf("gemini-3.5-flash")]);
  });

  it("fails fast only once every model in the chain is out for the day", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const realFetch = vi.fn(async () => perDay());
    const wrapped = wrap(realFetch);

    expect((await wrapped(url)).status).toBe(429);
    expect((await wrapped(urlOf("gemini-3.5-flash"))).status).toBe(429);
    const daily = /every model.*gemini-3\.5-flash-lite.*midnight Pacific/;
    await expect(wrapped(urlOf("gemini-3.5-flash-lite"))).rejects.toThrow(daily);
    await expect(wrapped(url)).rejects.toThrow(daily);
    expect(realFetch).toHaveBeenCalledTimes(3);
  });
});

describe("summary", () => {
  it("tables every case and counts primary against fallback answers", () => {
    const md = summary(
      [
        { name: "edit-amount", attempts: 1, model: "gemini-3.6-flash", passed: true },
        { name: "expense-and-income", attempts: 2, model: "gemini-3.5-flash-lite", passed: true },
        { name: "two-stores", attempts: 2, model: undefined, passed: false },
      ],
      "gemini-3.6-flash",
    );

    expect(md).toBe(
      [
        "| case | attempts | answering model | result |",
        "| --- | --- | --- | --- |",
        "| edit-amount | 1 | gemini-3.6-flash | pass |",
        "| expense-and-income | 2 | gemini-3.5-flash-lite | pass |",
        "| two-stores | 2 | none | fail |",
        "",
        "Answered by the primary gemini-3.6-flash: 1 of 3. By a fallback: 1. By no model: 1.",
        "",
      ].join("\n"),
    );
  });
});
