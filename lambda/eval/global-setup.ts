import { execFileSync } from "node:child_process";
import type { TestProject } from "vitest/node";
import setupDatabase from "../tests/integration/global-setup.js";
import { shouldRun } from "./harness.js";

declare module "vitest" {
  export interface ProvidedContext {
    evalSkip: boolean;
  }
}

/** Repo-relative paths changed between `base` and HEAD (since their merge base). */
function changedPaths(base: string): string[] {
  return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

export default async function setup({ provide }: TestProject): Promise<void> {
  const scope = shouldRun(process.env.EVAL_BASE, changedPaths);
  console.log(`eval: ${scope.why}`);
  provide("evalSkip", !scope.run);
  if (!scope.run) return;
  if (!process.env.GEMINI_EVAL_API_KEY) {
    // One line, no stack: the fix is a missing secret, not a code bug.
    const annotation = process.env.GITHUB_ACTIONS ? "::error::" : "";
    console.error(
      `${annotation}GEMINI_EVAL_API_KEY is not set: add it as an Actions secret (or export it locally) to run the live eval`,
    );
    process.exit(1);
  }
  // The prompt's taxonomy comes from the migrations and the example seed.
  await setupDatabase();
}
