// Manual end-to-end drive of the launcher heal against a REAL npx launch:
// it poisons the package's npx entry the way the field does — an install
// killed mid-way (taskkill/SIGKILL, a reload, a cut download), or with
// `--short` one npm finished short: complete but for the platform binaries
// it was meant to hold, as npm leaves it when their download is cut — shows npx
// failing on it as a user would see it (`--raw`, which also lets npm judge
// the dead install's lock stale first), then connects through the pool —
// at once, as a reconnect right after a Stop would, the dead install's lock
// still fresh — which heals the entry, installs the package and
// initializes. Not a vitest test (real npm network, minutes). Point npm at
// a scratch cache so the user's own stays untouched, and pick the npm under
// test by PATH:
//
//   npm_config_cache=/some/scratch PATH=/path/to/npm11/bin:$PATH \
//     npx tsx test/support/e2e-repair-drive.ts [pkg@version] [--raw] [--short]
import { spawn, spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { droppedOptionals, npxEntryDir, npxEntryState } from "../../src/orchestrator/launcher-health";
import { AgentPool } from "../../src/orchestrator/pool";
import { killTree, treeSpawnOptions } from "../../src/orchestrator/process-tree";
import type { PatchbayAgentId } from "../../src/shared/ids";
import { stubFsTerminalHooks } from "./stub-hooks";

// The ACP SDK's receive loop rejects unhandled when the child dies mid-
// connect; the extension host logs-and-survives those, so this drive does
// the same.
process.on("unhandledRejection", (err) => console.log(`[unhandled] ${(err as Error).message}`));

const args = process.argv.slice(2);
const pkgSpec = args.find((a) => !a.startsWith("--")) ?? "@agentclientprotocol/claude-agent-acp@0.86.0";
const pkgName = pkgSpec.slice(0, pkgSpec.lastIndexOf("@"));

const log = {
  trace: (m: string) => console.log(`[trace] ${m}`),
  info: (m: string) => console.log(`[info ] ${m}`),
  debug: (m: string) => console.log(`[debug] ${m}`),
  warn: (m: string) => console.log(`[warn ] ${m}`),
  error: (m: string) => console.log(`[error] ${m}`),
};

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function main(): Promise<void> {
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" }).stdout.trim();
  const cache = spawnSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).stdout.trim();
  const entry = npxEntryDir(join(cache, "_npx"), pkgSpec);
  console.log(`npm ${npm}, entry ${entry}`);

  // 1. Poison: start the install, kill it once the package is unpacked —
  // or let it finish and take out the platform binaries it holds.
  if (args.includes("--short")) {
    spawnSync("npx", ["-y", "--package", pkgSpec, "node", "--version"], { stdio: "ignore" });
    const { packages } = JSON.parse(await readFile(join(entry, "node_modules", ".package-lock.json"), "utf8")) as {
      packages: Record<string, { optional?: boolean; os?: string[]; cpu?: string[] }>;
    };
    for (const [path, record] of Object.entries(packages)) {
      if (record.optional === true && (record.os !== undefined || record.cpu !== undefined)) {
        await rm(join(entry, path), { recursive: true, force: true });
        console.log(`removed ${path}`);
      }
    }
    console.log(`poisoned — entry reads ${await npxEntryState(entry)}, missing ${JSON.stringify(await droppedOptionals(entry, process.env))}`);
  } else {
    const install = spawn("npx", ["-y", "--package", pkgSpec, "node", "--version"], { stdio: "ignore", ...treeSpawnOptions });
    while (!(await exists(join(entry, "node_modules", ...pkgName.split("/"), "package.json")))) {
      await new Promise((r) => setTimeout(r, 25));
    }
    killTree(install.pid!, "SIGKILL");
    await new Promise((r) => install.once("exit", r));
    console.log(`poisoned — entry reads ${await npxEntryState(entry)}`);
  }

  // 2. What a user's launch does with it.
  if (args.includes("--raw")) {
    const raw = spawnSync("npx", ["-y", pkgSpec], { encoding: "utf8", input: "" });
    console.log(`raw npx exit ${raw.status}:\n${raw.stderr.trim().split("\n").slice(-4).join("\n")}`);
  }

  // 3. The pool's launch.
  const pool = new AgentPool(
    {
      onStatusChanged: (id, status, detail) => console.log(`[status] ${id}: ${status}${detail ? ` — ${detail}` : ""}`),
      onDeclaredCaptured: () => {},
      onSessionUpdate: () => {},
      ...stubFsTerminalHooks(),
    },
    log,
  );
  const started = Date.now();
  const declared = await pool.connect({
    patchbayAgentId: "drive" as PatchbayAgentId,
    name: pkgName,
    command: "npx",
    args: ["-y", pkgSpec],
    env: {},
    cwd: process.cwd(),
  });
  console.log(`CONNECTED in ${Date.now() - started} ms — entry reads ${await npxEntryState(entry)}, missing ${JSON.stringify(await droppedOptionals(entry, process.env))}; declared ${JSON.stringify(declared).slice(0, 100)}…`);
  await pool.disposeAll();
  process.exit(0);
}
void main();
