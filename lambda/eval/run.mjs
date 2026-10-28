// `npm run eval [-- --record]`. Vitest rejects unknown flags, so --record
// travels to the eval as EVAL_RECORD.
import { startVitest } from "vitest/node";

process.env.EVAL_RECORD = process.argv.includes("--record") ? "1" : "";

const vitest = await startVitest("test", [], { config: "eval/vitest.config.ts", run: true });
await vitest?.close();
