// The electron suite's way into patchbay: the doors a user has — the views'
// actions, VS Code's own dialogs — and what the views are shown. A suite
// reaches nothing behind them, so a refactor that keeps the behavior keeps
// the suite green. The few suites whose subject is a mechanism itself (the
// channels' sync, the editor-state host, the login executor, the socket)
// reach that one mechanism, and say so.
import * as assert from "node:assert";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { fakeAgentStore, type AgentConfig } from "./fake-agent-config";
import { answeringYes } from "./modal";
import { waitFor } from "./wait-for";

export interface Block {
  id: string;
  kind: string;
  text?: string;
  resolution?: unknown;
}

export interface AgentRow {
  id: string;
  status: string;
  capabilities?: Record<string, { declared: boolean; used: boolean }>;
  update?: { from: string; to: string };
}

/** What the Agent View is shown — the part the suites read. */
export interface AgentViewState {
  agents: AgentRow[];
  sessions: Array<{ id: string; busy: readonly string[] }>;
  activeSessionId: string | null;
  screen: { pointer: boolean };
  transcripts: Record<string, Block[]>;
  contextRoots: Record<string, readonly string[]>;
}

/** What Settings is shown — the part the suites read. */
interface SettingsState {
  machineCommandRules: ReadonlyArray<{ pattern: string }>;
  registryFetchedAt: string;
  registryAgents: ReadonlyArray<{ id: string }>;
}

/** A channel's sync with its mounted webview. */
export interface ViewSync<S> {
  current: S;
  revision: number;
  waitForApplied(rev?: number): Promise<number>;
}

interface Orchestrator {
  handleAction(action: { kind: string } & Record<string, unknown>): void;
  agentView: ViewSync<AgentViewState>;
  settings: ViewSync<SettingsState>;
}

/** For a suite whose subject is a mechanism behind the views: the
 * extension's internals, typed by what that suite reaches. */
export async function internals<T>(): Promise<T> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  return ((await ext.activate()) as { internal: T }).internal;
}

/** The scriptable fake agent the suites connect. */
export function fakeAgentPath(): string {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  return join(ext.extensionUri.fsPath, "out-test", "fake-agent.mjs");
}

export class Patchbay {
  private constructor(private readonly orchestrator: Orchestrator) {}

  static async open(): Promise<Patchbay> {
    return new Patchbay((await internals<{ orchestrator: Orchestrator }>()).orchestrator);
  }

  /** The views' one door — the action a click sends. */
  act(action: { kind: string } & Record<string, unknown>): void {
    this.orchestrator.handleAction(action);
  }

  /** The Agent View's state and its sync with the mounted webview. */
  get agentView(): ViewSync<AgentViewState> {
    return this.orchestrator.agentView;
  }

  get view(): AgentViewState {
    return this.orchestrator.agentView.current;
  }

  get settings(): SettingsState {
    return this.orchestrator.settings.current;
  }

  agent(patchbayAgentId: string): AgentRow | undefined {
    return this.view.agents.find((a) => a.id === patchbayAgentId);
  }

  /** Settings' Add: the config saved, the agent listed. */
  async addAgent(config: AgentConfig): Promise<void> {
    this.act({ kind: "addOrUpdateAgentConfig", config });
    await waitFor(() => (this.agent(config.id) !== undefined ? true : undefined), 8000, `${config.id} listed`);
  }

  async connect(patchbayAgentId: string): Promise<void> {
    this.act({ kind: "connectAgent", source: { patchbayAgentId } });
    await waitFor(
      () => (this.agent(patchbayAgentId)?.status === "running" ? true : undefined),
      15000,
      () => `${patchbayAgentId} running (status: ${this.agent(patchbayAgentId)?.status})`,
    );
  }

  /** Stop, its question answered yes. */
  async stop(patchbayAgentId: string): Promise<void> {
    await answeringYes(async () => {
      this.act({ kind: "stopAgent", patchbayAgentId });
      await waitFor(() => (this.agent(patchbayAgentId)?.status !== "running" ? true : undefined), 8000, `${patchbayAgentId} stopped`);
    });
  }

  /** Remove, its question answered yes — and a fake agent's records with
   * it. */
  async remove(patchbayAgentId: string): Promise<void> {
    await answeringYes(async () => {
      this.act({ kind: "removeAgentConfig", patchbayAgentId });
      await waitFor(() => (this.agent(patchbayAgentId) === undefined ? true : undefined), 8000, `${patchbayAgentId} removed`);
    });
    await rm(fakeAgentStore(patchbayAgentId), { recursive: true, force: true });
  }

  /** A new chat with the agent — the session it lands on. An agent's
   * never-prompted session is reused, as the product does: prompt it
   * before asking for another. */
  async newSession(patchbayAgentId: string): Promise<string> {
    const known = new Set(this.view.sessions.map((s) => s.id));
    this.act({ kind: "startChat", patchbayAgentId });
    return waitFor(
      () => {
        const id = this.view.activeSessionId;
        return id !== null && !known.has(id) ? id : undefined;
      },
      15000,
      `a new session for ${patchbayAgentId}`,
    );
  }

  /** The words sent from the composer, at once; settles once their turn
   * has ended and left the session's line. */
  async prompt(sessionId: string, text: string): Promise<void> {
    const before = this.turnsEnded(sessionId);
    this.act({ kind: "sendPrompt", sessionId, text });
    await waitFor(
      () => (this.turnsEnded(sessionId) > before && !this.busy(sessionId).includes("prompt") ? true : undefined),
      15000,
      `a turn ended in ${sessionId}`,
    );
  }

  busy(sessionId: string): readonly string[] {
    return this.view.sessions.find((s) => s.id === sessionId)?.busy ?? [];
  }

  switchTo(sessionId: string): void {
    this.act({ kind: "switchSession", sessionId });
  }

  /** The roots chip's Add, its folder picked in the dialog. */
  async addRoot(sessionId: string, path: string): Promise<void> {
    const window = vscode.window as { showOpenDialog: (...args: unknown[]) => Thenable<vscode.Uri[] | undefined> };
    const original = window.showOpenDialog;
    window.showOpenDialog = async () => [vscode.Uri.file(path)];
    try {
      this.act({ kind: "addContextRoot", sessionId });
      await waitFor(() => (this.view.contextRoots[sessionId]?.includes(path) ? true : undefined), 8000, `root ${path}`);
    } finally {
      window.showOpenDialog = original;
    }
  }

  /** The `index`-th block of `kind` in a session's transcript, once there. */
  block(sessionId: string, kind: string, index = 0): Promise<Block> {
    return waitFor(
      () => (this.view.transcripts[sessionId] ?? []).filter((b) => b.kind === kind)[index],
      15000,
      `${kind} block ${index} in ${sessionId}`,
    );
  }

  /** The session's open card of `kind` — asked, not yet answered — once
   * there. */
  openCard(sessionId: string, kind: string): Promise<Block> {
    return waitFor(
      () => (this.view.transcripts[sessionId] ?? []).find((b) => b.kind === kind && b.resolution === null),
      15000,
      `an open ${kind} card in ${sessionId}`,
    );
  }

  /** A proposed write answered on its card; settles once the card shows
   * the answer. */
  async answerDiff(sessionId: string, card: Block, accept: boolean): Promise<void> {
    this.act({ kind: "resolveDiff", requestId: card.id, accept });
    await waitFor(
      () => ((this.view.transcripts[sessionId] ?? []).find((b) => b.id === card.id)?.resolution != null ? true : undefined),
      8000,
      `diff ${card.id} answered`,
    );
  }

  /** The text the agent has written in a session so far. */
  text(sessionId: string): string {
    return (this.view.transcripts[sessionId] ?? [])
      .filter((b) => b.kind === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  /** A machine command rule, as the Permissions page adds it. */
  async addMachineRule(pattern: string, verdict: "allow" | "ask" | "deny"): Promise<void> {
    this.act({ kind: "addCommandRule", rule: { pattern, verdict }, layer: "machine" });
    await waitFor(() => (this.hasMachineRule(pattern) ? true : undefined), 8000, `rule ${pattern}`);
  }

  async removeMachineRule(pattern: string): Promise<void> {
    this.act({ kind: "removeCommandRule", pattern, layer: "machine" });
    await waitFor(() => (this.hasMachineRule(pattern) ? undefined : true), 8000, `rule ${pattern} gone`);
  }

  /** A registry fetch landing with these agents: the CDN is served by a
   * stand-in fetch (left in place — the suite hands the network back), and
   * Settings' refresh reads it. A refresh asked while another read is under
   * way joins that read, so it is asked again until a read of these agents
   * has landed. */
  async landRegistry(...agents: Array<{ id: string } & Record<string, unknown>>): Promise<void> {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ version: "1.0.0", agents }), { headers: { "content-type": "application/json" } });
    const since = this.settings.registryFetchedAt;
    const ids = agents.map((a) => a.id).sort().join();
    const landed = () =>
      this.settings.registryFetchedAt !== since &&
      [...this.settings.registryAgents.map((a) => a.id)].sort().join() === ids;
    for (let asked = 0; !landed(); asked++) {
      if (asked === 5) assert.fail("the served registry never landed");
      this.act({ kind: "refreshRegistry" });
      await waitFor(() => (landed() ? true : undefined), 3000).catch(() => {});
    }
  }

  private turnsEnded(sessionId: string): number {
    return (this.view.transcripts[sessionId] ?? []).filter((b) => b.kind === "turnEnd").length;
  }

  private hasMachineRule(pattern: string): boolean {
    return this.settings.machineCommandRules.some((r) => r.pattern === pattern);
  }
}
