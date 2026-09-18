// The real probe against a real stdio MCP server whose startup depends on
// its working directory (test/support/cwd-marker-server.mjs) — no faked
// probeFn: real spawn, real MCP handshake, real cwd. Both directions of the
// one fact: where the marker is, the probe lists the tool; where it isn't,
// the server dies before the handshake and the probe reports exactly what
// a real session would have hit. The manager-level tests (integrations.test.ts)
// prove the cwd handed in is the workspace's; this proves the handed-in cwd
// is where the command actually runs.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeMcpServer } from "../src/orchestrator/integration-probe";

const SERVER = join(process.cwd(), "test", "support", "cwd-marker-server.mjs");

let withMarker: string;
let bare: string;
beforeEach(async () => {
  withMarker = await mkdtemp(join(tmpdir(), "patchbay-probe-marker-"));
  bare = await mkdtemp(join(tmpdir(), "patchbay-probe-bare-"));
  await writeFile(join(withMarker, "probe-marker"), "hello-from-workspace\n");
});
afterEach(async () => {
  await rm(withMarker, { recursive: true, force: true });
  await rm(bare, { recursive: true, force: true });
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
