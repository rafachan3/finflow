// Checks docs/TESTING.md against the tests: every behaviour row cites at
// least one test, and every cited test exists. `node scripts/check-inventory.mjs`
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Rows of the `| Area | Behaviour | Tests |` table; Tests holds backtick-quoted titles. */
export function parseInventory(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
    if (cells.length !== 3 || cells[0] === "Area" || /^[-:\s]*$/.test(cells[0])) continue;
    const tests = [...cells[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ area: cells[0], behaviour: cells[1], tests });
  }
  return rows;
}

/** The titles of every `it`, `test` and `describe` call in a test file. */
export function testTitles(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const call =
    /\b(?:it|test|describe)(?:\.(?:only|skip))?(?:\.each\([\s\S]*?\)(?=\(\s*["'`]))?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  return new Set([...code.matchAll(call)].map((m) => m[2].replace(/\\(.)/g, "$1")));
}

/** Problems with the inventory, one line each; empty when it holds. */
export function checkInventory(rows, titles, goldens) {
  if (rows.length === 0) return ["docs/TESTING.md has no behaviour inventory table"];
  const problems = [];
  for (const { area, behaviour, tests } of rows) {
    const who = `${area}: ${behaviour}`;
    if (tests.length === 0) problems.push(`${who} has no test`);
    for (const test of tests) {
      if (test.startsWith("golden:")) {
        const name = test.slice("golden:".length);
        if (!goldens.has(name)) {
          problems.push(`${who} cites a golden case that does not exist: ${name}`);
        }
      } else if (!titles.has(test)) {
        problems.push(`${who} cites a test that does not exist: ${test}`);
      }
    }
  }
  return problems;
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const sources = ["lambda/tests", "lambda/eval"]
    .flatMap((d) => files(join(root, d)))
    .filter((f) => /\.(ts|mjs)$/.test(f));
  const titles = new Set(sources.flatMap((f) => [...testTitles(readFileSync(f, "utf8"))]));
  const goldens = new Set(
    readdirSync(join(root, "lambda/tests/golden"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length)),
  );
  const rows = parseInventory(readFileSync(join(root, "docs/TESTING.md"), "utf8"));
  const problems = checkInventory(rows, titles, goldens);
  for (const p of problems) console.error(`inventory: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`inventory: ${rows.length} behaviours, every cited test exists`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
