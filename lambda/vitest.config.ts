import { defineConfig } from "vitest/config";

const integration = {
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    // Files share one database and truncate it per test.
    fileParallelism: false,
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
