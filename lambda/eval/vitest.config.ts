import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Live Gemini eval; `npm test` never runs it. See eval/run.mjs.
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["eval/**/*.eval.ts"],
    globalSetup: ["eval/global-setup.ts"],
    // Cases run one at a time and may wait out a 20-minute Gemini outage.
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30 * 60_000,
  },
});
