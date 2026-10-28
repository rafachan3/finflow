import { describe, expect, it } from "vitest";
import {
  checkInventory,
  parseInventory,
  testTitles,
} from "../../scripts/check-inventory.mjs";

const TABLE = `
# Testing

| Area | Behaviour | Tests |
|---|---|---|
| Security | Bad secret is refused | \`refuses a bad secret\`<br>\`ignores a stranger\` |
| Notes | Note is saved | \`golden:text-with-note\` |

Some prose with | pipes | in it.
`;

describe("parseInventory", () => {
  it("reads one row per behaviour with its backtick-quoted tests", () => {
    expect(parseInventory(TABLE)).toEqual([
      {
        area: "Security",
        behaviour: "Bad secret is refused",
        tests: ["refuses a bad secret", "ignores a stranger"],
      },
      { area: "Notes", behaviour: "Note is saved", tests: ["golden:text-with-note"] },
    ]);
  });

  it("keeps a row whose tests cell is empty, so it can be reported", () => {
    const rows = parseInventory("| Area | Behaviour | Tests |\n|---|---|---|\n| A | B |  |\n");
    expect(rows).toEqual([{ area: "A", behaviour: "B", tests: [] }]);
  });

  it("ignores other tables with three columns", () => {
    const other = "| Layer | Command | Needs |\n|---|---|---|\n| Unit | npm test | nothing |\n\n";
    expect(parseInventory(other + TABLE)).toHaveLength(2);
  });

  it("finds no rows in a document without the table", () => {
    expect(parseInventory("# Testing\n\nNothing here.\n")).toEqual([]);
  });
});

describe("testTitles", () => {
  it("collects it, test and describe titles, including multi-line calls", () => {
    const source = [
      'describe("a suite", () => {',
      '  it("does a thing", () => {});',
      "  test('does another', () => {});",
      "  it(",
      '    "spans lines",',
      "    { timeout: 5 },",
      "    async () => {},",
      "  );",
      '  it.each([[1]])("handles %s", () => {});',
      '  it("says \\"quoted\\"", () => {});',
      "});",
    ].join("\n");
    expect([...testTitles(source)].sort()).toEqual(
      ["a suite", 'says "quoted"', "does a thing", "does another", "spans lines", "handles %s"].sort(),
    );
  });

  it("ignores titles in comments", () => {
    expect([...testTitles('// it("commented out", () => {});')]).toEqual([]);
  });
});

describe("checkInventory", () => {
  const titles = new Set(["refuses a bad secret", "ignores a stranger"]);
  const goldens = new Set(["text-with-note"]);

  it("passes when every behaviour has tests that exist", () => {
    expect(checkInventory(parseInventory(TABLE), titles, goldens)).toEqual([]);
  });

  it("fails a behaviour with no test", () => {
    const rows = [{ area: "Notes", behaviour: "Note is saved", tests: [] }];
    expect(checkInventory(rows, titles, goldens)).toEqual(["Notes: Note is saved has no test"]);
  });

  it("fails a referenced test that does not exist", () => {
    const rows = [
      { area: "Security", behaviour: "Bad secret is refused", tests: ["renamed away"] },
    ];
    expect(checkInventory(rows, titles, goldens)).toEqual([
      "Security: Bad secret is refused cites a test that does not exist: renamed away",
    ]);
  });

  it("fails a golden case that has no file", () => {
    const rows = [{ area: "Notes", behaviour: "Note is saved", tests: ["golden:gone"] }];
    expect(checkInventory(rows, titles, goldens)).toEqual([
      "Notes: Note is saved cites a golden case that does not exist: gone",
    ]);
  });

  it("fails an empty inventory, so a deleted table cannot pass", () => {
    expect(checkInventory([], titles, goldens)).toEqual([
      "docs/TESTING.md has no behaviour inventory table",
    ]);
  });
});
