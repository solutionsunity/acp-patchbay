// The real probe against a real stdio MCP server whose startup depends on
// its working directory (test/support/cwd-marker-server.mjs) — no faked
// probeFn: real spawn, real MCP handshake, real cwd. Both directions of the
// one fact: where the marker is, the probe lists the tool; where it isn't,
// the server dies before the handshake and the probe reports exactly what
// a real session would have hit. The store-level tests (mcp-servers-store.test.ts)
// prove the cwd handed in is the workspace's; this proves the handed-in cwd
// is where the command actually runs.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./support/teardown";
import { SETTLE, waitFor } from "./support/wait-for";
import { probeMcpServer } from "../src/orchestrator/mcp-probe";
import { isAlive } from "../src/orchestrator/process-tree";

const SERVER = join(process.cwd(), "test", "support", "cwd-marker-server.mjs");

let withMarker: string;
let bare: string;
beforeEach(async () => {
  withMarker = await tempDir("patchbay-probe-marker-");
  bare = await tempDir("patchbay-probe-bare-");
  await writeFile(join(withMarker, "probe-marker"), "hello-from-workspace\n");
});

const target = (cwd: string) =>
  ({ kind: "stdio", command: process.execPath, args: [SERVER], env: {}, cwd }) as const;

describe("probeMcpServer — a stdio server runs in the cwd it is given", () => {
  it("finds the server's project-local config when cwd is the directory holding it", async () => {
    const outcome = await probeMcpServer(target(withMarker));
    expect(outcome.serverName).toBe("cwd-marker-server");
    expect(outcome.tools).toEqual([{ name: "report_cwd", description: "marker: hello-from-workspace" }]);
  });

  it("surfaces the server's own refusal when cwd lacks it — the failure a session would hit", async () => {
    await expect(probeMcpServer(target(bare))).rejects.toThrow(/Connection closed/);
  });
});

describe("probeMcpServer — the server's whole tree ends with the probe", () => {
  it("a server run by a launcher goes with its launcher, not orphaned", async () => {
    // A launcher's shape (npx → node): a parent that runs the server on its
    // own stdio and waits, the server holding on past its input's end.
    const launcher = `require("node:child_process").spawn(process.execPath, ${JSON.stringify([SERVER, "--hold"])}, { stdio: "inherit" }); setInterval(() => {}, 1 << 30);`;
    const outcome = await probeMcpServer({ kind: "stdio", command: process.execPath, args: ["-e", launcher], env: {}, cwd: withMarker });
    const serverPid = Number(outcome.serverVersion);
    expect(serverPid).toBeGreaterThan(0);
    try {
      await waitFor(() => !isAlive(serverPid), SETTLE.timeout, "the launcher's server to end");
    } finally {
      if (isAlive(serverPid)) process.kill(serverPid, "SIGKILL"); // an orphan the suite must not leave
    }
  }, 3 * SETTLE.timeout); // the shutdown's graces and the wait, with room for the cleanup to run
});
