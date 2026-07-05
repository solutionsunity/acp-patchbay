// Scriptable fake ACP agent — the real test bed (plan.md § Toolchain calls).
// Skeleton after the SDK's example agent (typescript-sdk/src/examples/agent.ts,
// Apache-2.0, Zed Industries), extended with a behavior script so it can be
// told to lie: declare a capability and drop the calls, confirm a rejected
// mode change, crash on demand. Lying is the only way to test
// declared-vs-verified honesty deterministically.
//
// Every update sent during a turn is also durably recorded per session under
// `<cwd>/.fake-agent-sessions/` — simulating what a real agent's own storage
// does — so `session/load` can replay it verbatim after this process is
// killed and a fresh one spawned in its place (a real crash/restart, not an
// in-memory shortcut).
//
// Script arrives as JSON in the FAKE_AGENT_SCRIPT env var.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export type TurnStep =
  | { type: "chunk"; text: string }
  | { type: "thought"; text: string }
  | { type: "toolCall"; id: string; title: string }
  | { type: "toolDone"; id: string }
  | {
      type: "plan";
      entries: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
    }
  | { type: "usage"; used: number; size: number }
  | { type: "commands"; names: string[] }
  | { type: "crash" }
  | { type: "writeFile"; path: string; content: string }
  | { type: "readFile"; path: string }
  | { type: "runCommand"; command: string; args?: string[] }
  | { type: "askPermission"; title: string; kind: "execute" | "edit"; subject: string };

export interface FakeAgentScript {
  name?: string;
  /** agentCapabilities fragment returned from initialize. */
  declare?: acp.AgentCapabilities;
  authMethods?: acp.AuthMethod[];
  /** Steps streamed per prompt turn (default: two text chunks). */
  turn?: TurnStep[];
  stepDelayMs?: number;
  /** "fail" → second live session/new is rejected (concurrency knob). */
  concurrent?: "ok" | "fail";
  /** Modes offered at session/new (P8 knobs). */
  modes?: acp.SessionModeState | null;
  lies?: {
    /** session/set_mode returns success but mode never changes, no update emitted. */
    modeChangeNoop?: boolean;
    /** session/fork declared but errors when called. */
    forkBroken?: boolean;
  };
}

const script: FakeAgentScript = JSON.parse(process.env.FAKE_AGENT_SCRIPT ?? "{}");
const stepDelay = script.stepDelayMs ?? 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeSession {
  id: string;
  cwd: string;
  pending: AbortController | null;
  mode: string | null;
}

const sessions = new Map<string, FakeSession>();
let sessionCounter = 0;

// ── durable per-session record, so session/load survives this process dying ─

function storeFile(cwd: string, sessionId: string): string {
  return join(cwd, ".fake-agent-sessions", `${sessionId}.jsonl`);
}

function recordUpdate(cwd: string, sessionId: string, update: acp.SessionUpdate): void {
  const file = storeFile(cwd, sessionId);
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, JSON.stringify(update) + "\n", "utf8");
}

function readRecordedUpdates(cwd: string, sessionId: string): acp.SessionUpdate[] {
  const file = storeFile(cwd, sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as acp.SessionUpdate);
}

async function emitUpdate(
  cx: acp.AgentContext,
  sessionId: string,
  cwd: string,
  update: acp.SessionUpdate,
): Promise<void> {
  recordUpdate(cwd, sessionId, update);
  await cx.notify(acp.methods.client.session.update, { sessionId, update });
}

const defaultTurn: TurnStep[] = [
  { type: "chunk", text: "Hello from the fake agent. " },
  { type: "chunk", text: "This turn is scripted." },
];

async function runTurn(
  sessionId: string,
  cwd: string,
  promptText: string,
  signal: AbortSignal,
  cx: acp.AgentContext,
): Promise<acp.StopReason> {
  if (promptText.includes("__crash__")) process.exit(1);

  const steps = script.turn ?? defaultTurn;
  for (const step of steps) {
    if (signal.aborted) return "cancelled";
    await sleep(stepDelay);
    if (signal.aborted) return "cancelled";

    switch (step.type) {
      case "crash":
        process.exit(1);
        break;
      case "chunk":
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: step.text },
        });
        break;
      case "thought":
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: step.text },
        });
        break;
      case "toolCall":
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "tool_call",
          toolCallId: step.id,
          title: step.title,
          kind: "other",
          status: "in_progress",
        });
        break;
      case "toolDone":
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "tool_call_update",
          toolCallId: step.id,
          status: "completed",
        });
        break;
      case "plan":
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "plan",
          entries: step.entries.map((e) => ({
            content: e.content,
            status: e.status,
            priority: "medium" as const,
          })),
        });
        break;
      case "usage":
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "usage_update",
          used: step.used,
          size: step.size,
        });
        break;
      case "commands":
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "available_commands_update",
          availableCommands: step.names.map((name) => ({
            name,
            description: `fake ${name}`,
          })),
        });
        break;
      case "writeFile": {
        let result: string;
        try {
          await cx.request(acp.methods.client.fs.writeTextFile, {
            sessionId,
            path: step.path,
            content: step.content,
          });
          result = "write: ok";
        } catch (err) {
          result = `write: rejected (${(err as Error).message})`;
        }
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result },
        });
        break;
      }
      case "readFile": {
        const response = await cx.request(acp.methods.client.fs.readTextFile, {
          sessionId,
          path: step.path,
        });
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `read: ${response.content}` },
        });
        break;
      }
      case "runCommand": {
        let result: string;
        try {
          const created = await cx.request(acp.methods.client.terminal.create, {
            sessionId,
            command: step.command,
            args: step.args ?? [],
          });
          const exit = await cx.request(acp.methods.client.terminal.waitForExit, {
            sessionId,
            terminalId: created.terminalId,
          });
          const out = await cx.request(acp.methods.client.terminal.output, {
            sessionId,
            terminalId: created.terminalId,
          });
          await cx.request(acp.methods.client.terminal.release, {
            sessionId,
            terminalId: created.terminalId,
          });
          result = `command: exit=${exit.exitCode} output=${out.output.trim()}`;
        } catch (err) {
          result = `command: rejected (${(err as Error).message})`;
        }
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result },
        });
        break;
      }
      case "askPermission": {
        // "edit" carries its path via the standard `locations` field — the
        // one subject shape ACP actually guarantees. "execute" has no
        // equivalent standard field for the command string, so a real
        // agent's own permission ask can't be rule-matched reliably; the
        // honest broker behavior is to always ask for those (enforcement
        // happens for real at patchbay's own terminal/create gate instead).
        const response = await cx.request(acp.methods.client.session.requestPermission, {
          sessionId,
          toolCall: {
            toolCallId: `ask-${sessionId}`,
            title: step.title,
            kind: step.kind,
            locations: step.kind === "edit" ? [{ path: step.subject }] : undefined,
          },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        });
        const outcome =
          response.outcome.outcome === "cancelled" ? "cancelled" : response.outcome.optionId;
        await emitUpdate(cx, sessionId, cwd, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `permission: ${outcome}` },
        });
        break;
      }
    }
  }
  return "end_turn";
}

function promptText(prompt: acp.ContentBlock[]): string {
  return prompt
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ");
}

const app = acp
  .agent({ name: script.name ?? "fake-agent" })
  .onRequest("initialize", (): acp.InitializeResponse => {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: script.declare ?? {},
      authMethods: script.authMethods ?? [],
      agentInfo: { name: script.name ?? "fake-agent", version: "0.0.0" },
    };
  })
  .onRequest("session/new", (ctx): acp.NewSessionResponse => {
    if (script.concurrent === "fail" && sessions.size > 0) {
      throw acp.RequestError.invalidRequest("concurrent sessions unsupported");
    }
    const id = `fake-${++sessionCounter}`;
    sessions.set(id, {
      id,
      cwd: ctx.params.cwd,
      pending: null,
      mode: script.modes?.currentModeId ?? null,
    });
    const response: acp.NewSessionResponse = { sessionId: id };
    if (script.modes) response.modes = script.modes;
    return response;
  })
  .onRequest("session/load", async (ctx): Promise<acp.LoadSessionResponse> => {
    if (script.declare?.loadSession !== true) {
      throw acp.RequestError.methodNotFound("session/load");
    }
    const { sessionId, cwd } = ctx.params;
    sessions.set(sessionId, {
      id: sessionId,
      cwd,
      pending: null,
      mode: script.modes?.currentModeId ?? null,
    });
    for (const update of readRecordedUpdates(cwd, sessionId)) {
      await ctx.client.notify(acp.methods.client.session.update, { sessionId, update });
    }
    const response: acp.LoadSessionResponse = {};
    if (script.modes) response.modes = script.modes;
    return response;
  })
  .onRequest("session/prompt", async (ctx): Promise<acp.PromptResponse> => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw acp.RequestError.invalidRequest("unknown session");
    session.pending?.abort();
    session.pending = new AbortController();
    const stopReason = await runTurn(
      ctx.params.sessionId,
      session.cwd,
      promptText(ctx.params.prompt),
      session.pending.signal,
      ctx.client,
    );
    session.pending = null;
    return { stopReason };
  })
  .onRequest("session/set_mode", async (ctx): Promise<acp.SetSessionModeResponse> => {
    const session = sessions.get(ctx.params.sessionId);
    if (!session) throw acp.RequestError.invalidRequest("unknown session");
    if (script.lies?.modeChangeNoop) {
      return {}; // the lie: success reported, nothing changed, no update emitted
    }
    session.mode = ctx.params.modeId;
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: session.id,
      update: { sessionUpdate: "current_mode_update", currentModeId: ctx.params.modeId },
    });
    return {};
  })
  .onRequest("session/fork", (ctx): acp.ForkSessionResponse => {
    if (script.lies?.forkBroken || script.declare?.sessionCapabilities?.fork == null) {
      throw acp.RequestError.methodNotFound("session/fork");
    }
    const parent = sessions.get(ctx.params.sessionId);
    if (!parent) throw acp.RequestError.invalidRequest("unknown session");
    const id = `${parent.id}-fork-${++sessionCounter}`;
    sessions.set(id, { id, cwd: parent.cwd, pending: null, mode: parent.mode });
    return { sessionId: id };
  })
  .onNotification("session/cancel", (ctx) => {
    sessions.get(ctx.params.sessionId)?.pending?.abort();
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
app.connect(stream);
