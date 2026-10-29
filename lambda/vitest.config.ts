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
    // Reset once for vitest 4, whose v8 remapping counts callbacks and
    // branches that v3 skipped (e.g. `.map((r) => r.name)` on empty seeds).
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { lines: 88, statements: 87, branches: 81, functions: 94 },
    },
    projects: [
      { test: { name: "unit", include: ["tests/*.test.{ts,mjs}"] } },
      ...(process.env.TEST_DATABASE_URL ? [integration] : []),
    ],
  },
});
