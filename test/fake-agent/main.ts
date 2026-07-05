// Scriptable fake ACP agent — the real test bed (plan.md § Toolchain calls).
// Skeleton after the SDK's example agent (typescript-sdk/src/examples/agent.ts,
// Apache-2.0, Zed Industries), extended with a behavior script so it can be
// told to lie: declare a capability and drop the calls, confirm a rejected
// mode change, crash on demand. Lying is the only way to test
// declared-vs-verified honesty deterministically.
//
// Script arrives as JSON in the FAKE_AGENT_SCRIPT env var.
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
  | { type: "crash" };

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
  pending: AbortController | null;
  mode: string | null;
}

const sessions = new Map<string, FakeSession>();
let sessionCounter = 0;

const defaultTurn: TurnStep[] = [
  { type: "chunk", text: "Hello from the fake agent. " },
  { type: "chunk", text: "This turn is scripted." },
];

async function runTurn(
  sessionId: string,
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
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: step.text },
          },
        });
        break;
      case "thought":
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: step.text },
          },
        });
        break;
      case "toolCall":
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: step.id,
            title: step.title,
            kind: "other",
            status: "in_progress",
          },
        });
        break;
      case "toolDone":
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: step.id,
            status: "completed",
          },
        });
        break;
      case "plan":
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "plan",
            entries: step.entries.map((e) => ({
              content: e.content,
              status: e.status,
              priority: "medium" as const,
            })),
          },
        });
        break;
      case "usage":
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: step.used,
            size: step.size,
          },
        });
        break;
      case "commands":
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: step.names.map((name) => ({
              name,
              description: `fake ${name}`,
            })),
          },
        });
        break;
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
  .onRequest("session/new", (): acp.NewSessionResponse => {
    if (script.concurrent === "fail" && sessions.size > 0) {
      throw acp.RequestError.invalidRequest("concurrent sessions unsupported");
    }
    const id = `fake-${++sessionCounter}`;
    sessions.set(id, { id, pending: null, mode: script.modes?.currentModeId ?? null });
    const response: acp.NewSessionResponse = { sessionId: id };
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
    sessions.set(id, { id, pending: null, mode: parent.mode });
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
