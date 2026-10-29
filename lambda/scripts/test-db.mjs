// Per-checkout throwaway Postgres: container name and starting host port are
// derived from the repo root path, so parallel worktrees never share a database.
// Usage: node scripts/test-db.mjs up|down|url
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PORT_MIN = 54330;
const PORT_COUNT = 100; // 54330-54429

export function dbIdentity(root) {
  const n = createHash("sha256").update(root).digest();
  return {
    name: `finflow-test-db-${n.toString("hex").slice(0, 8)}`,
    basePort: PORT_MIN + (n.readUInt32BE(8) % PORT_COUNT),
  };
}

const urlFor = (port) => `postgres://postgres:postgres@localhost:${port}/postgres`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function portFree(port) {
  return new Promise((ok) => {
    const s = createServer().once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

function runningPort(name) {
  try {
    return docker("port", name, "5432/tcp").split("\n")[0].split(":").pop();
  } catch {
    return null; // not running
  }
}

async function main() {
  const root = resolve(fileURLToPath(import.meta.url), "../../..");
  const { name, basePort } = dbIdentity(root);
  const cmd = process.argv[2];
  const port = runningPort(name);

  if (cmd === "down") {
    if (!port) return console.log(`${name} is not running`);
    docker("stop", name);
    return console.log(`stopped ${name}`);
  }
  if (cmd === "url") {
    if (!port) {
      console.error(`${name} is not running; run npm run db:up`);
      process.exit(1);
    }
    return console.log(urlFor(port));
  }
  if (cmd !== "up") {
    console.error("usage: test-db.mjs up|down|url");
    process.exit(1);
  }
  if (!port) {
    let chosen = null;
    for (let i = 0; i < PORT_COUNT && !chosen; i++) {
      const p = PORT_MIN + ((basePort - PORT_MIN + i) % PORT_COUNT);
      if (await portFree(p)) chosen = p;
    }
    if (!chosen) {
      console.error(`no free port in ${PORT_MIN}-${PORT_MIN + PORT_COUNT - 1}`);
      process.exit(1);
    }
    docker("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=postgres",
      "-p", `127.0.0.1:${chosen}:5432`, "postgres:17");
    console.log(`started ${name} on port ${chosen}`);
  } else {
    console.log(`${name} already running on port ${port}`);
  }
  console.log(`TEST_DATABASE_URL=${urlFor(port ?? runningPort(name))}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
