// Manual end-to-end drive of the launcher-cache repair chokepoint against
// the REAL codex-acp npx launch. Precondition: the npx cache entry for
// @agentclientprotocol/codex-acp has been poisoned (no .bin, no root
// package.json — the observed 2026-07-11 corruption). Expected: first spawn
// dies "codex-acp: not found", pool purges + retries once, initialize
// round-trips. Not a vitest test (real npm network, minutes); run with
// `npx tsx test/support/e2e-repair-drive.ts`.
import { AgentPool } from "../../src/orchestrator/pool";
import { stubFsTerminalHooks } from "./stub-hooks";

// The ACP SDK's receive loop rejects unhandled when the child dies mid-
// connect; the extension host logs-and-survives those, so this drive does
// the same rather than letting node kill the run before the retry.
process.on("unhandledRejection", (err) => console.log(`[unhandled] ${(err as Error).message}`));

const log = {
  trace: (m: string) => console.log(`[trace] ${m}`),
  info: (m: string) => console.log(`[info ] ${m}`),
  debug: (m: string) => console.log(`[debug] ${m}`),
  warn: (m: string) => console.log(`[warn ] ${m}`),
  error: (m: string) => console.log(`[error] ${m}`),
};

const pool = new AgentPool(
  {
    onStatusChanged: (id, status, detail, stderr) =>
      console.log(`[status] ${id}: ${status}${detail ? ` — ${detail}` : ""}${stderr ? ` | stderr: ${stderr.join(" / ")}` : ""}`),
    onDeclaredCaptured: () => {},
    onSessionUpdate: () => {},
    ...stubFsTerminalHooks(),
  },
  log,
);

async function main(): Promise<void> {
  const declared = await pool.connect({
    agentId: "codex-acp",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.2"],
    env: {},
    cwd: process.cwd(),
  });
  console.log(`CONNECTED — declared caps captured: ${JSON.stringify(declared).slice(0, 120)}…`);
  await pool.disposeAll();
  process.exit(0);
}
void main();
