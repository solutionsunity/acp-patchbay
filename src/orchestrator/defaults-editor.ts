// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The Settings defaults editor's reading of an agent's knob surface — for
// the combination being edited, from the agent itself. An agent's surface
// is a function of its own selections: OpenCode offers `effort` only for
// models that have variants, with values that differ per model. So no
// one-time read at agent defaults can show the knobs a saved default would
// reveal, and no cached union could state their values honestly (option
// lists come from remote providers and move without the agent's version
// moving). This holds at most one throwaway session per agent — the
// standing probe dir, no MCP servers, never an LLM turn — opened when a
// card's knob editor expands, seeded with the stored defaults to a fixed
// point, re-read after every edit, closed when the editor collapses or the
// panel closes (no idle timer: a released surface under a still-expanded
// card would be a state the card cannot show). It holds no truth: the store
// does. A dead or stale session is thrown away and the surface recomputed
// from the store — never reconciled. vscode-free; the orchestrator wires
// the store, the normalizer, and the latch.
import type { NewSessionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import {
  applyConfigUpdate,
  applyModeUpdate,
  applySeedToFixedPoint,
  performKnobSet,
  toOfferedKnobs,
  type KnobSetRoute,
  type KnobWire,
  type NormalizedKnobs,
} from "./knobs";
import { nullLogger, type Logger } from "./logger";
import type { AgentPool } from "./pool";
import type { KnobSeed, SettingsEvent } from "../shared/protocol";

export interface DefaultsEditorHooks {
  /** The agent's standing probe workspace — never a user workspace root. */
  probeRoot(agentId: string): Promise<string>;
  /** The stored defaults — the one durable fact the session is seeded from. */
  defaultsFor(agentId: string): KnobSeed;
  /** The one normalizer (spec surfaces plus extension extras), so the editor
   * offers exactly what the composer would. */
  normalize(response: NewSessionResponse): NormalizedKnobs;
  /** Whether a throwaway session may open on this agent right now — false
   * while a latched agent's first-session privilege is unspent. */
  mayOpen(agentId: string): boolean;
  emit(...events: SettingsEvent[]): void;
}

interface Editing {
  sessionId: string;
  knobs: NormalizedKnobs;
  /** The seed the session currently embodies — what defaultsChanged diffs
   * against to decide between a set and a recompute. */
  applied: KnobSeed;
}

export class DefaultsEditor {
  private readonly editing = new Map<string, Editing>();
  /** Per-agent serialization: opens, sets, and closes on one agent never
   * interleave, so the surface published is always the reply to the last
   * request — later wins by construction. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly pool: AgentPool,
    private readonly hooks: DefaultsEditorHooks,
    private readonly log: Logger = nullLogger,
  ) {}

  /** The editor expanded (or the agent it shows came up): ensure a seeded
   * session and publish its surface. Idempotent. */
  open(agentId: string): Promise<void> {
    return this.enqueue(agentId, () => this.ensure(agentId));
  }

  /** The stored defaults moved while the editor is open: a changed or added
   * entry is set on the session (and the surface it yields published); a
   * removed entry has no wire form — the session is recomputed from the
   * store. Nothing to do while no editor is open for this agent. */
  defaultsChanged(agentId: string): Promise<void> {
    return this.enqueue(agentId, async () => {
      const entry = this.editing.get(agentId);
      if (entry === undefined) return;
      const next = this.hooks.defaultsFor(agentId);
      const removed = Object.keys(entry.applied).some((k) => !(k in next));
      if (removed) {
        await this.end(agentId, entry);
        await this.ensure(agentId);
        return;
      }
      const changed = Object.fromEntries(
        Object.entries(next).filter(([k, v]) => entry.applied[k] !== v),
      );
      await this.seed(agentId, entry, changed);
      entry.applied = next;
      this.publish(agentId, entry);
    });
  }

  /** The editor collapsed: end the session and release the surface. */
  close(agentId: string): Promise<void> {
    return this.enqueue(agentId, async () => {
      const entry = this.editing.get(agentId);
      if (entry === undefined) return;
      await this.end(agentId, entry);
      this.hooks.emit({ kind: "agentKnobsReleased", agentId });
    });
  }

  closeAll(): Promise<void> {
    return Promise.all([...this.editing.keys()].map((id) => this.close(id))).then(() => {});
  }

  /** The connection is gone (stopped, crashed, reconnecting): the session
   * died with it — drop the entry without a wire call. The reducer drops
   * the surface on the same status event. */
  forget(agentId: string): void {
    this.editing.delete(agentId);
  }

  /** Agent-scoped, like the probe's identity: session ids are only unique
   * within one agent's connection. */
  owns(agentId: string, sessionId: string): boolean {
    return this.editing.get(agentId)?.sessionId === sessionId;
  }

  /** The editing session's own notifications — the agent's transition duty
   * confirms sets out of band (mode changes; config updates some agents
   * send in addition to the response). */
  handleUpdate(agentId: string, notification: SessionNotification): void {
    const entry = this.editing.get(agentId);
    if (entry === undefined || entry.sessionId !== notification.sessionId) return;
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      entry.knobs = applyConfigUpdate(update.configOptions, entry.knobs, (m) => this.log.info(m));
    } else if (update.sessionUpdate === "current_mode_update") {
      const next = applyModeUpdate(entry.knobs, update.currentModeId);
      if (next === null) return;
      entry.knobs = next;
    } else return;
    this.publish(agentId, entry);
  }

  private async ensure(agentId: string): Promise<void> {
    const existing = this.editing.get(agentId);
    if (existing !== undefined) {
      this.publish(agentId, existing);
      return;
    }
    if (this.pool.get(agentId)?.status !== "running") return; // the card states "connect to edit"
    if (!this.hooks.mayOpen(agentId)) {
      this.hooks.emit({
        kind: "agentKnobsObserved",
        agentId,
        knobs: { knobs: [], unavailable: "defaults can be edited after this agent's first session" },
      });
      return;
    }
    const dir = await this.hooks.probeRoot(agentId);
    let response: NewSessionResponse;
    try {
      response = await this.pool.newSession(agentId, dir);
    } catch (err) {
      // auth_required or a plain failure — stated on the card, never a
      // spinner that spins forever; needsAuth itself is the pool's own
      // wire chokepoint's business.
      this.hooks.emit({
        kind: "agentKnobsObserved",
        agentId,
        knobs: { knobs: [], unavailable: `couldn't open a session to read knobs — ${(err as Error).message}` },
      });
      return;
    }
    const entry: Editing = {
      sessionId: response.sessionId,
      knobs: this.hooks.normalize(response),
      applied: {},
    };
    this.editing.set(agentId, entry);
    const defaults = this.hooks.defaultsFor(agentId);
    await this.seed(agentId, entry, defaults);
    entry.applied = defaults;
    this.publish(agentId, entry);
  }

  private async seed(agentId: string, entry: Editing, seed: KnobSeed): Promise<void> {
    await applySeedToFixedPoint(
      seed,
      () => entry.knobs,
      (route, _knobId, value) => this.set(agentId, entry, route, value),
    );
  }

  /** One routed set; a rejection leaves the agent's state standing (the
   * surface still reflects what the agent actually holds). A null next
   * state means the agent confirms by notification — handleUpdate. */
  private async set(agentId: string, entry: Editing, route: KnobSetRoute, value: string | boolean): Promise<void> {
    try {
      const next = await performKnobSet(this.knobWire(agentId), entry.sessionId, () => entry.knobs, route, value, (m) =>
        this.log.info(m),
      );
      if (next !== null) entry.knobs = next;
    } catch (err) {
      this.log.info(`${agentId}: defaults editor set rejected — ${(err as Error).message}`);
    }
  }

  /** The wire one routed set needs, bound to this agent's connection (the
   * editor's sessions live on the agent's own pool key, never an isolated
   * clone). */
  private knobWire(agentId: string): KnobWire {
    return {
      setMode: (sessionId, modeId) => this.pool.setSessionMode(agentId, sessionId, modeId),
      setConfigOption: (sessionId, configId, value) =>
        this.pool.setSessionConfigOption(agentId, sessionId, configId, value),
      send: (method, params) => this.pool.unstableRequest(agentId, method, params),
    };
  }

  private publish(agentId: string, entry: Editing): void {
    this.hooks.emit({ kind: "agentKnobsObserved", agentId, knobs: { knobs: toOfferedKnobs(entry.knobs.knobs) } });
  }

  /** Ends the session agent-side where the agent can (close, then delete —
   * the same hygiene the probe applies: a list-capable agent's history must
   * not accrete one junk session per edit) and drops the entry. */
  private async end(agentId: string, entry: Editing): Promise<void> {
    this.editing.delete(agentId);
    const declared = this.pool.get(agentId)?.declared;
    if (declared?.sessionClose) await this.pool.closeSession(agentId, entry.sessionId).catch(() => {});
    if (declared?.sessionDelete) await this.pool.deleteSession(agentId, entry.sessionId).catch(() => {});
  }

  private enqueue(agentId: string, task: () => Promise<void>): Promise<void> {
    const chain = (this.queues.get(agentId) ?? Promise.resolve())
      .then(task)
      .catch((err: Error) => this.log.info(`${agentId}: defaults editor — ${err.message}`));
    this.queues.set(agentId, chain);
    return chain;
  }
}
