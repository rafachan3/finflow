import { defineConfig } from "vitest/config";

const integration = {
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts", "tests/journeys/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // Files share one database and truncate it per test, so one worker
    // runs them in turn (fileParallelism is ignored inside a project).
    maxWorkers: 1,
  },
};

if (!process.env.TEST_DATABASE_URL) {
  console.warn(
    "TEST_DATABASE_URL not set: integration tests skipped (see AGENTS.md Verification)",
  );
}

export default defineConfig({
  test: {
    // `npm run test:coverage`. The floor is measured on unit plus integration
    // plus journeys (needs TEST_DATABASE_URL); raise it, never lower it.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { lines: 90, statements: 90, branches: 84, functions: 98 },
    },
    projects: [
      { test: { name: "unit", include: ["tests/*.test.{ts,mjs}"] } },
      ...(process.env.TEST_DATABASE_URL ? [integration] : []),
    ],
  },
});
