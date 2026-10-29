// `npm run eval [-- --record]`. Vitest rejects unknown flags, so --record
// travels to the eval as EVAL_RECORD.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { startVitest } from "vitest/node";

process.env.EVAL_RECORD = process.argv.includes("--record") ? "1" : "";

// A local run may keep the key in the main checkout's .env (gitignored),
// which a worktree shares. The environment wins.
const root = dirname(
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim(),
);
const envFile = join(root, ".env");
if (!process.env.GEMINI_EVAL_API_KEY && existsSync(envFile)) {
  const key = parseEnv(readFileSync(envFile, "utf8")).GEMINI_EVAL_API_KEY;
  if (key) process.env.GEMINI_EVAL_API_KEY = key;
}

const vitest = await startVitest("test", [], { config: "eval/vitest.config.ts", run: true });
await vitest?.close();
