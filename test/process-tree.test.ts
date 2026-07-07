// P15 gate (mechanics half): tree-wide kill against real spawned process
// trees, the PID-reuse guard, orphan reaping, and pool.stop's graceful
// ladder against a SIGTERM-ignoring agent that survives stdin EOF — the
// exact process the ladder exists for. POSIX group semantics throughout;
// the Windows arm of killTree is taskkill (untestable here — covered by the
// process-tree.ts implementation note, not silently assumed).
import { spawn } from "node:child_process";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { commandOf, isAlive, killTree, reapOrphans, treeSpawnOptions } from "../src/orchestrator/process-tree";
import { AgentPool } from "../src/orchestrator/pool";
import { stubFsTerminalHooks } from "./support/stub-hooks";

const posix = describe.skipIf(process.platform === "win32");

async function waitUntil(probe: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!probe()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** `sh` leader that reports its `sleep` grandchild's pid on stdout, then
 * waits — a real two-level tree. */
function spawnTree(): Promise<{ leaderPid: number; grandchildPid: number }> {
  return new Promise((resolve, reject) => {
    const sh = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
      ...treeSpawnOptions,
    });
    sh.once("error", reject);
    sh.stdout.setEncoding("utf8");
    let out = "";
    sh.stdout.on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n")[0];
      if (line !== undefined && line.trim() !== "") {
        resolve({ leaderPid: sh.pid!, grandchildPid: Number(line.trim()) });
      }
    });
  });
}

posix("killTree", () => {
  it("ends the whole tree, grandchild included", async () => {
    const { leaderPid, grandchildPid } = await spawnTree();
    expect(isAlive(leaderPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    killTree(leaderPid, "SIGKILL");
    await waitUntil(() => !isAlive(leaderPid) && !isAlive(grandchildPid), "tree death");
  });

  it("is a no-op on an already-dead tree — ESRCH is success", () => {
    expect(() => killTree(99_999_999, "SIGKILL")).not.toThrow();
  });
});

posix("commandOf", () => {
  it("reads a live command line, and \"\" for a gone pid", async () => {
    const child = spawn("sleep", ["300"], { stdio: "ignore", ...treeSpawnOptions });
    await waitUntil(() => child.pid !== undefined, "spawn");
    expect(await commandOf(child.pid!)).toContain("sleep");
    killTree(child.pid!, "SIGKILL");
    await waitUntil(() => !isAlive(child.pid!), "death");
    expect(await commandOf(child.pid!)).toBe("");
  });
});

posix("reapOrphans", () => {
  it("kills a live record whose command still matches; spares a mismatch (reused pid)", async () => {
    const orphan = spawn("sleep", ["300"], { stdio: "ignore", ...treeSpawnOptions });
    const bystander = spawn("sleep", ["301"], { stdio: "ignore", ...treeSpawnOptions });
    await waitUntil(() => orphan.pid !== undefined && bystander.pid !== undefined, "spawn");
    const records = [
      { pid: orphan.pid!, command: await commandOf(orphan.pid!) }, // honest record
      { pid: bystander.pid!, command: "something-entirely-different" }, // "reused" pid
      { pid: 99_999_999, command: "long gone" }, // dead — dropped silently
    ];

    const { killed, spared } = await reapOrphans(records);

    expect(killed.map((r) => r.pid)).toEqual([orphan.pid]);
    expect(spared.map((r) => r.pid)).toEqual([bystander.pid]);
    await waitUntil(() => !isAlive(orphan.pid!), "orphan death");
    expect(isAlive(bystander.pid!)).toBe(true); // never kill what we can't match
    killTree(bystander.pid!, "SIGKILL");
  });
});

// A minimal ACP agent that answers `initialize` correctly, then refuses to
// die politely: ignores SIGTERM, survives stdin EOF, and holds a real
// grandchild — everything the ladder's SIGKILL rung exists for. Inlined so
// this test file is self-contained (the fake agent stays a well-behaved
// citizen; stubbornness is this test's own concern).
const STUBBORN_AGENT = `
process.on("SIGTERM", () => {});
const { spawn } = require("node:child_process");
const grandchild = spawn("sleep", ["300"]);
console.error("grandchild " + grandchild.pid);
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: JSON.parse(process.env.ACP_PROTOCOL_VERSION),
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: "stubborn", version: "0.0.0" },
        },
      }) + "\\n");
    }
  }
});
process.stdin.on("end", () => {});
setInterval(() => {}, 1 << 30);
`;

posix("pool.stop ladder", () => {
  it("a SIGTERM-ignoring, EOF-surviving agent still ends up dead — tree and all — and reads \"stopped\"", async () => {
    const statuses: string[] = [];
    const pool = new AgentPool({
      onStatusChanged: (_id, status) => statuses.push(status),
      onDeclaredCaptured: () => {},
      onSessionUpdate: () => {},
      ...stubFsTerminalHooks(),
    });
    await pool.connect({
      agentId: "stubborn",
      name: "Stubborn",
      command: process.execPath,
      args: ["-e", STUBBORN_AGENT],
      env: { ACP_PROTOCOL_VERSION: JSON.stringify(PROTOCOL_VERSION) },
      cwd: process.cwd(),
    });

    // The grandchild announces itself on stderr → pool's stderrTail.
    let grandchildPid = 0;
    await waitUntil(() => {
      const line = pool.get("stubborn")?.stderrTail.find((l) => l.startsWith("grandchild "));
      if (line === undefined) return false;
      grandchildPid = Number(line.slice("grandchild ".length));
      return true;
    }, "grandchild announcement");
    expect(isAlive(grandchildPid)).toBe(true);

    await pool.stop("stubborn", { eofMs: 120, termMs: 250, killMs: 3_000 });

    expect(pool.get("stubborn")?.status).toBe("stopped");
    expect(statuses.at(-1)).toBe("stopped");
    await waitUntil(() => !isAlive(grandchildPid), "grandchild death");
  });
});
