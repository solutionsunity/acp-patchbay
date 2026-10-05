// P7 gate: "real agent reads selection + diagnostics in a turn." The fake
// agent here plays both roles honestly — a real ACP agent AND a real MCP
// client, exactly as production would — spawning the actual bundled MCP
// server as its own subprocess from the mcpServers entry session/new gave
// it. Only EditorStateHost's data source is stood in for (real vscode
// state needs a real extension host; see test-electron for that half).
//
// Every IPC request carries the context token the server was spawned with,
// and the host admits a request only by a token the sessions store minted
// for an attach (#72) — so these turns prove the token the store mints is
// the one the spawned server sends. get_selection/get_diagnostics/etc. are
// global editor state and need nothing more; request_user_input needs the
// real session (to know which transcript to post the elicitation card
// into), so that's where token → session is exercised and asserted.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeLine,
  parseLines,
  type IpcRequest,
  type IpcResponse,
} from "../src/mcp/ipc-protocol";
import { AgentPool, type LaunchSpec } from "../src/orchestrator/pool";
import { SessionsStore } from "../src/orchestrator/sessions-store";
import { MemoryKV } from "../src/orchestrator/stores/kv";
import { SessionContinuityStore } from "../src/orchestrator/stores/session-continuity";
import { initialAgentViewState, reduceAgentView, type AgentViewEvent } from "../src/shared/protocol";
import type { FakeAgentScript } from "./fake-agent/main";
import { stubFsTerminalHooks } from "./support/stub-hooks";
import { gatesFor } from "./support/session-gates";
import type { PatchbayAgentId } from "../src/shared/ids";

const FAKE_AGENT = join(process.cwd(), "out-test", "fake-agent.mjs");
const MCP_SERVER = join(process.cwd(), "out", "mcp-server.js");

/** Stands in for EditorStateHost — same wire protocol, canned data (real
 * vscode-backed data is test-electron/manual-smoke territory). Mirrors
 * Orchestrator's own split: every request is admitted by its token, and
 * requestUserInput translates the token to its session (it needs the real
 * one); the rest don't. */
class FakeEditorStateHost {
  server: Server;
  socketPath: string;
  requests: IpcRequest[] = [];
  /** The store whose attaches minted the tokens — set by the harness. */
  sessions: Pick<SessionsStore, "admits" | "sessionOfToken"> | null = null;

  constructor(id: string) {
    this.socketPath = join(tmpdir(), `patchbay-e2e-${id}.sock`);
    this.server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const { messages, rest } = parseLines(buffer);
        buffer = rest;
        for (const message of messages) {
          const req = message as IpcRequest;
          this.requests.push(req);
          const response: IpcResponse =
            this.sessions?.admits(req.sessionId) === true
              ? { id: req.id, result: this.answer(req) }
              : { id: req.id, error: "unknown session token" };
          socket.write(encodeLine(response));
        }
      });
    });
  }

  private answer(req: IpcRequest): unknown {
    switch (req.method) {
      case "getSelection":
        return { file: "/ws/pool.ts", startLine: 42, endLine: 87, text: "class AgentPool { ... }" };
      case "getDiagnostics":
        return [{ file: "/ws/pool.ts", line: 10, severity: "error", message: "unused import" }];
      case "requestUserInput": {
        const realSessionId = this.sessions?.sessionOfToken(req.sessionId);
        return { action: "accept", content: { resolvedFor: realSessionId } };
      }
      default:
        return null;
    }
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  close(): void {
    this.server.close();
  }
}

let dir: string;
let host: FakeEditorStateHost;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "patchbay-e2e-cwd-"));
  host = new FakeEditorStateHost(`${process.pid}-${Date.now()}`);
  await host.listen();
});
afterEach(async () => {
  host.close();
  await rm(dir, { recursive: true, force: true });
});

function spec(script: FakeAgentScript, patchbayAgentId: PatchbayAgentId): LaunchSpec {
  return {
    patchbayAgentId,
    name: "Fake Agent",
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    cwd: dir,
  };
}

/** Builds the exact mcpServers entry Orchestrator builds — same shape,
 * pointed at the fake IPC host instead of a real EditorStateHost. */
async function mcpServersFor(contextToken: string): Promise<{ servers: McpServer[]; given: [] }> {
  return {
    servers: [
      {
        name: "patchbay",
        command: process.execPath,
        args: [MCP_SERVER],
        env: [
          { name: "ACP_PATCHBAY_IPC", value: host.socketPath },
          { name: "ACP_PATCHBAY_SESSION_ID", value: contextToken },
        ],
      },
    ],
    given: [],
  };
}

function harness() {
  const events: AgentViewEvent[] = [];
  // Real production wiring: SessionsStore mints a context token per attach
  // and answers for it — the host (here the test's fake) admits a request
  // by it and finds its session through the store.
  const pool = new AgentPool({
    onStatusChanged: () => {},
    onDeclaredCaptured: () => {},
    onSessionUpdate: (patchbayAgentId, notification) => sessions.handleUpdate(patchbayAgentId, notification),
    ...stubFsTerminalHooks(),
  });
  const sessions = new SessionsStore(
    pool,
    { emit: (...evs) => events.push(...evs) },
    new SessionContinuityStore(new MemoryKV()),
    () => dir,
    mcpServersFor,
  );
  host.sessions = sessions;
  return {
    pool,
    sessions,
    gates: gatesFor(sessions, (event) => events.push(event)),
    state: () => events.reduce(reduceAgentView, initialAgentViewState),
  };
}

describe("local MCP server, end to end through a real agent process", () => {
  it("the agent reads the live selection via the local MCP server", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "get_selection" }] }, "e1" as PatchbayAgentId));
    const sessionId = await h.sessions.createSession("e1" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(sessionId, { text: "what's selected?" });

    const text = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && JSON.parse(text.text)).toEqual({
      file: "/ws/pool.ts",
      startLine: 42,
      endLine: 87,
      text: "class AgentPool { ... }",
    });
    await h.pool.stop("e1" as PatchbayAgentId);
  });

  it("the agent reads diagnostics via the local MCP server — opportunistically verifiable data", async () => {
    const h = harness();
    await h.pool.connect(spec({ turn: [{ type: "callMcpTool", tool: "get_diagnostics" }] }, "e2" as PatchbayAgentId));
    const sessionId = await h.sessions.createSession("e2" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(sessionId, { text: "any problems?" });

    const text = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && JSON.parse(text.text)).toEqual([
      { file: "/ws/pool.ts", line: 10, severity: "error", message: "unused import" },
    ]);
    await h.pool.stop("e2" as PatchbayAgentId);
  });

  it("request_user_input resolves against the real sessionId, not the raw correlation token", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "callMcpTool", tool: "request_user_input", args: { message: "ok?" } }] }, "e3" as PatchbayAgentId),
    );
    const sessionId = await h.sessions.createSession("e3" as PatchbayAgentId, "Fake Agent", dir);
    await h.gates.prompt(sessionId, { text: "go" });

    const text = h.state().transcripts[sessionId]!.find((b) => b.kind === "text");
    expect(text?.kind === "text" && JSON.parse(text.text)).toEqual({ resolvedFor: sessionId });
    // and the IPC request itself carried the raw token, confirming the
    // fake host's translation (mirroring Orchestrator's) is what did the work
    expect(host.requests.some((r) => r.method === "requestUserInput" && r.sessionId !== sessionId)).toBe(
      true,
    );
    await h.pool.stop("e3" as PatchbayAgentId);
  });

  it("two sessions on the same agent get independent correlation tokens", async () => {
    const h = harness();
    await h.pool.connect(
      spec({ turn: [{ type: "callMcpTool", tool: "request_user_input", args: { message: "ok?" } }] }, "e4" as PatchbayAgentId),
    );
    const s1 = await h.sessions.createSession("e4" as PatchbayAgentId, "Fake Agent", dir);
    const s2 = await h.sessions.createSession("e4" as PatchbayAgentId, "Fake Agent", dir);
    expect(s1).not.toBe(s2);

    await h.gates.prompt(s1, { text: "go" });
    await h.gates.prompt(s2, { text: "go" });

    const resolvedFor = (sid: string) => {
      const text = h.state().transcripts[sid]!.find((b) => b.kind === "text");
      return text?.kind === "text" ? JSON.parse(text.text).resolvedFor : undefined;
    };
    // each session's tool call resolved against its own sessionId, never the other's
    expect(resolvedFor(s1)).toBe(s1);
    expect(resolvedFor(s2)).toBe(s2);
    await h.pool.stop("e4" as PatchbayAgentId);
  });
});
