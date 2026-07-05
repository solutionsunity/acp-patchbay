// Bridges the ACP client pool to the Agent View's chat state. Owns the render
// cache in the sense of deciding *when* it must be rebuilt wholesale — the
// cache itself lives in AgentViewState, updated only through the shared
// reducer (architecture.md § State: render cache is disposable, replay
// always wins, never merged).
import type {
  ContentBlock,
  SessionNotification,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentViewEvent, PlanEntry, SessionSummary } from "../shared/protocol";
import type { AgentPool } from "./pool";
import type { SessionIndexStore } from "./stores/session-index";

export interface SessionManagerHooks {
  emit(...events: AgentViewEvent[]): void;
}

let blockCounter = 0;
function newBlockId(prefix: string): string {
  return `${prefix}-${++blockCounter}`;
}

function deriveTitle(promptText: string): string {
  const flat = promptText.trim().replace(/\s+/g, " ");
  if (flat === "") return "Untitled session";
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

interface LiveSession {
  agentId: string;
  /** True once auto-derived from the first prompt, or explicitly renamed —
   * either way, later auto-titling must not clobber it again. */
  titled: boolean;
  activeTextBlockId: string | null;
  activeThoughtBlockId: string | null;
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();

  constructor(
    private readonly pool: AgentPool,
    private readonly sessionIndex: SessionIndexStore,
    private readonly hooks: SessionManagerHooks,
    /** cwd for (re)connecting a session — v1 has one cwd per workspace. */
    private readonly cwd: () => string,
  ) {}

  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async createSession(
    agentId: string,
    agentName: string,
    cwd: string,
  ): Promise<string> {
    const { sessionId } = await this.pool.newSession(agentId, cwd);
    this.sessions.set(sessionId, {
      agentId,
      titled: false,
      activeTextBlockId: null,
      activeThoughtBlockId: null,
    });
    const now = new Date().toISOString();
    const title = `${agentName} session`;
    await this.sessionIndex.upsert({ id: sessionId, agentId, title, createdAt: now, updatedAt: now });
    const summary: SessionSummary = {
      id: sessionId,
      agentId,
      title,
      live: false,
      emulated: false,
      branchOf: null,
    };
    this.hooks.emit({ kind: "sessionCreated", session: summary });
    return sessionId;
  }

  activate(sessionId: string): void {
    this.hooks.emit({ kind: "sessionActivated", sessionId });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.titled = true; // an explicit rename is never overwritten by auto-titling
    await this.sessionIndex.rename(sessionId, title);
    this.hooks.emit({ kind: "sessionRenamed", sessionId, title });
  }

  async close(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.sessionIndex.remove(sessionId);
    this.hooks.emit({ kind: "sessionClosed", sessionId });
  }

  /** Drops bookkeeping for sessions whose connection just died — a stale
   * sessionId cannot be used on a new connection until reopened. */
  invalidateAgent(agentId: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.agentId !== agentId) continue;
      this.sessions.delete(sessionId);
      this.hooks.emit({ kind: "sessionLiveChanged", sessionId, live: false });
    }
  }

  /** Re-attaches a session after its connection died, via `session/load`
   * replay — the render cache is discarded and rebuilt wholesale, never
   * merged with what patchbay had. A sessionId is connection-scoped: without
   * replay there is no protocol-legal way to resume it on the new
   * connection. The render cache still stands as a last-known view for
   * display; seeding a fresh, labeled continuation from it is P8 (session
   * graph, emulated branching) — out of scope here. */
  private async reopen(sessionId: string, agentId: string): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    const declared = this.pool.get(agentId)?.declared;
    if (!declared?.loadSession) {
      throw new Error(
        `session ${sessionId} is no longer live and ${agentId} does not support session/load`,
      );
    }
    this.sessions.set(sessionId, {
      agentId,
      titled: true, // reopened sessions keep whatever title they already have
      activeTextBlockId: null,
      activeThoughtBlockId: null,
    });
    this.hooks.emit({ kind: "transcriptReset", sessionId });
    await this.pool.loadSession(agentId, sessionId, this.cwd());
    this.hooks.emit({ kind: "capabilityVerified", agentId, row: "session.load" });
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const agentId = this.sessions.get(sessionId)?.agentId ?? this.sessionIndex.get(sessionId)?.agentId;
    if (agentId === undefined) throw new Error(`unknown session ${sessionId}`);
    await this.reopen(sessionId, agentId);
    const session = this.sessions.get(sessionId)!;
    session.activeTextBlockId = null;
    session.activeThoughtBlockId = null;

    const events: AgentViewEvent[] = [];
    if (!session.titled) {
      session.titled = true;
      const title = deriveTitle(text);
      await this.sessionIndex.rename(sessionId, title);
      events.push({ kind: "sessionRenamed", sessionId, title });
    }
    events.push(
      { kind: "userMessageAppended", sessionId, blockId: newBlockId("user"), text },
      { kind: "sessionLiveChanged", sessionId, live: true },
    );
    this.hooks.emit(...events);

    const prompt: ContentBlock[] = [{ type: "text", text }];
    try {
      await this.pool.prompt(session.agentId, sessionId, prompt);
    } finally {
      this.hooks.emit({ kind: "sessionLiveChanged", sessionId, live: false });
    }
  }

  async stopTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.pool.cancel(session.agentId, sessionId);
  }

  /** Routed from AgentPool's onSessionUpdate hook — handles both live
   * streaming and session/load replay identically (same notification shape). */
  handleUpdate(agentId: string, notification: SessionNotification): void {
    const { sessionId, update } = notification;
    const session = this.sessions.get(sessionId);
    if (!session) return; // update for a session patchbay isn't tracking

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") return;
        session.activeTextBlockId ??= newBlockId("text");
        this.hooks.emit({
          kind: "agentTextDelta",
          sessionId,
          blockId: session.activeTextBlockId,
          text: update.content.text,
        });
        break;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        session.activeThoughtBlockId ??= newBlockId("thought");
        this.hooks.emit({
          kind: "agentThoughtDelta",
          sessionId,
          blockId: session.activeThoughtBlockId,
          text: update.content.text,
        });
        break;
      }
      case "tool_call":
        session.activeTextBlockId = null; // a following chunk starts a fresh text block
        this.hooks.emit({
          kind: "toolCallUpserted",
          sessionId,
          blockId: update.toolCallId,
          title: update.title,
          status: update.status ?? "pending",
        });
        break;
      case "tool_call_update":
        this.hooks.emit({
          kind: "toolCallUpserted",
          sessionId,
          blockId: update.toolCallId,
          title: update.title ?? "",
          status: update.status ?? "completed",
        });
        break;
      case "plan":
        this.hooks.emit({
          kind: "planAppended",
          sessionId,
          blockId: newBlockId("plan"),
          entries: toPlanEntries(update.entries),
        });
        break;
      case "available_commands_update":
        this.hooks.emit({
          kind: "commandsAdvertised",
          sessionId,
          commands: update.availableCommands.map((c) => ({
            name: c.name,
            description: c.description,
          })),
        });
        break;
      case "usage_update":
        // No initialize-time claim exists for usage reporting — declared
        // and verified arrive together, the moment it's first observed.
        this.hooks.emit(
          {
            kind: "usageReported",
            sessionId,
            used: update.used,
            size: update.size,
            cost: update.cost ?? undefined,
          },
          { kind: "capabilityVerified", agentId, row: "usage" },
        );
        break;
      default:
        break; // unconsumed schema surface — a future capability row, not silently guessed at
    }
  }
}

function toPlanEntries(
  entries: readonly { content: string; status: "pending" | "in_progress" | "completed" }[],
): PlanEntry[] {
  return entries.map((e) => ({ content: e.content, status: e.status }));
}
