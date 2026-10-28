import { defineConfig } from "vitest/config";

const integration = {
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // Files share one database and truncate it per test, so one worker
    // runs them in turn (fileParallelism is ignored inside a project).
    poolOptions: { forks: { singleFork: true } },
  },
};

if (!process.env.TEST_DATABASE_URL) {
  console.warn(
    "TEST_DATABASE_URL not set: integration tests skipped (see AGENTS.md Verification)",
  );
}

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["tests/*.test.ts"] } },
      ...(process.env.TEST_DATABASE_URL ? [integration] : []),
    ],
  },
});
