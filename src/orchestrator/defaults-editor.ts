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
import type { SessionOpenedFact } from "./readers/responses";
import { agentErrorText } from "./readers/agent-error";
import type { SessionUpdateFact } from "./readers/session-update";
import {
  applyConfigUpdate,
  applyModeUpdate,
  applySeedToFixedPoint,
  NO_KNOBS,
  performKnobSet,
  toOfferedKnobs,
  type KnobSetRoute,
  type KnobWire,
  type NormalizedKnobs,
} from "./knobs";
import { nullLogger, type Logger } from "./logger";
import type { AgentPool } from "./pool";
import type { KnobSeed, SettingsEvent } from "../shared/protocol";
import type { PatchbayAgentId } from "../shared/ids";

export interface DefaultsEditorHooks {
  /** The agent's standing probe workspace — never a user workspace root. */
  probeRoot(patchbayAgentId: PatchbayAgentId): Promise<string>;
  /** The stored defaults — the one durable fact the session is seeded from. */
  defaultsFor(patchbayAgentId: PatchbayAgentId): KnobSeed;
  /** Whether a throwaway session may open on this agent right now — false
   * while a latched agent's first-session privilege is unspent. */
  mayOpen(patchbayAgentId: PatchbayAgentId): boolean;
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
  private readonly editing = new Map<PatchbayAgentId, Editing>();
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
  open(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.enqueue(patchbayAgentId, () => this.ensure(patchbayAgentId));
  }

  /** The stored defaults moved while the editor is open: a changed or added
   * entry is set on the session (and the surface it yields published); a
   * removed entry has no wire form — the session is recomputed from the
   * store. Nothing to do while no editor is open for this agent. */
  defaultsChanged(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.enqueue(patchbayAgentId, async () => {
      const entry = this.editing.get(patchbayAgentId);
      if (entry === undefined) return;
      const next = this.hooks.defaultsFor(patchbayAgentId);
      const removed = Object.keys(entry.applied).some((k) => !(k in next));
      if (removed) {
        await this.end(patchbayAgentId, entry);
        await this.ensure(patchbayAgentId);
        return;
      }
      const changed = Object.fromEntries(
        Object.entries(next).filter(([k, v]) => entry.applied[k] !== v),
      );
      await this.seed(patchbayAgentId, entry, changed);
      entry.applied = next;
      this.publish(patchbayAgentId, entry);
    });
  }

  /** The editor collapsed: end the session and release the surface. */
  close(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return this.enqueue(patchbayAgentId, async () => {
      const entry = this.editing.get(patchbayAgentId);
      if (entry === undefined) return;
      await this.end(patchbayAgentId, entry);
      this.hooks.emit({ kind: "agentKnobsReleased", patchbayAgentId });
    });
  }

  closeAll(): Promise<void> {
    return Promise.all([...this.editing.keys()].map((patchbayAgentId) => this.close(patchbayAgentId))).then(() => {});
  }

  /** The connection is gone (stopped, crashed, reconnecting): the session
   * died with it — drop the entry without a wire call. The reducer drops
   * the surface on the same status event. */
  forget(patchbayAgentId: PatchbayAgentId): void {
    this.editing.delete(patchbayAgentId);
  }

  /** Agent-scoped, like the probe's identity: session ids are only unique
   * within one agent's connection. */
  owns(patchbayAgentId: PatchbayAgentId, sessionId: string): boolean {
    return this.editing.get(patchbayAgentId)?.sessionId === sessionId;
  }

  /** The editing session's own notifications — the agent's transition duty
   * confirms sets out of band (mode changes; config updates some agents
   * send in addition to the response). */
  handleUpdate(patchbayAgentId: PatchbayAgentId, sessionId: string, update: SessionUpdateFact): void {
    const entry = this.editing.get(patchbayAgentId);
    if (entry === undefined || entry.sessionId !== sessionId) return;
    if (update.kind === "configOptions") {
      entry.knobs = applyConfigUpdate(update.configOptions, entry.knobs, (m) => this.log.info(m));
    } else if (update.kind === "mode") {
      const next = applyModeUpdate(entry.knobs, update.currentModeId);
      if (next === null) return;
      entry.knobs = next;
    } else return;
    this.publish(patchbayAgentId, entry);
  }

  private async ensure(patchbayAgentId: PatchbayAgentId): Promise<void> {
    const existing = this.editing.get(patchbayAgentId);
    if (existing !== undefined) {
      this.publish(patchbayAgentId, existing);
      return;
    }
    if (this.pool.get(patchbayAgentId)?.status !== "running") return; // the card states "connect to edit"
    if (!this.hooks.mayOpen(patchbayAgentId)) {
      this.hooks.emit({
        kind: "agentKnobsObserved",
        patchbayAgentId,
        knobs: { knobs: [], unavailable: "defaults can be edited after this agent's first session" },
      });
      return;
    }
    const dir = await this.hooks.probeRoot(patchbayAgentId);
    let response: SessionOpenedFact;
    try {
      response = await this.pool.newSession(patchbayAgentId, dir);
    } catch (err) {
      // auth_required or a plain failure — stated on the card, never a
      // spinner that spins forever; needsAuth itself is the pool's own
      // wire chokepoint's business.
      this.hooks.emit({
        kind: "agentKnobsObserved",
        patchbayAgentId,
        knobs: { knobs: [], unavailable: `couldn't open a session to read knobs — ${agentErrorText(err)}` },
      });
      return;
    }
    const entry: Editing = {
      sessionId: response.sessionId,
      // read by the pool's one normalizer, so the editor offers exactly
      // what the composer would
      knobs: response.knobs ?? NO_KNOBS,
      applied: {},
    };
    this.editing.set(patchbayAgentId, entry);
    const defaults = this.hooks.defaultsFor(patchbayAgentId);
    await this.seed(patchbayAgentId, entry, defaults);
    entry.applied = defaults;
    this.publish(patchbayAgentId, entry);
  }

  private async seed(patchbayAgentId: PatchbayAgentId, entry: Editing, seed: KnobSeed): Promise<void> {
    await applySeedToFixedPoint(
      seed,
      () => entry.knobs,
      (route, _knobId, value) => this.set(patchbayAgentId, entry, route, value),
    );
  }

  /** One routed set; a rejection leaves the agent's state standing (the
   * surface still reflects what the agent actually holds). A null next
   * state means the agent confirms by notification — handleUpdate. */
  private async set(patchbayAgentId: PatchbayAgentId, entry: Editing, route: KnobSetRoute, value: string | boolean): Promise<void> {
    try {
      const next = await performKnobSet(this.knobWire(patchbayAgentId), entry.sessionId, () => entry.knobs, route, value, (m) =>
        this.log.info(m),
      );
      if (next !== null) entry.knobs = next;
    } catch (err) {
      this.log.info(`${patchbayAgentId}: defaults editor set rejected — ${agentErrorText(err)}`);
    }
  }

  /** The wire one routed set needs, bound to this agent's connection. */
  private knobWire(patchbayAgentId: PatchbayAgentId): KnobWire {
    return {
      setMode: (sessionId, modeId) => this.pool.setSessionMode(patchbayAgentId, sessionId, modeId),
      setConfigOption: (sessionId, configId, value) =>
        this.pool.setSessionConfigOption(patchbayAgentId, sessionId, configId, value),
      send: (method, params) => this.pool.unstableRequest(patchbayAgentId, method, params),
    };
  }

  private publish(patchbayAgentId: PatchbayAgentId, entry: Editing): void {
    this.hooks.emit({ kind: "agentKnobsObserved", patchbayAgentId, knobs: { knobs: toOfferedKnobs(entry.knobs.knobs) } });
  }

  /** Ends the session agent-side where the agent can (close, then delete —
   * the same hygiene the probe applies: a list-capable agent's history must
   * not accrete one junk session per edit) and drops the entry. */
  private async end(patchbayAgentId: PatchbayAgentId, entry: Editing): Promise<void> {
    this.editing.delete(patchbayAgentId);
    const declared = this.pool.get(patchbayAgentId)?.declared;
    if (declared?.sessionClose) await this.pool.closeSession(patchbayAgentId, entry.sessionId).catch(() => {});
    if (declared?.sessionDelete) await this.pool.deleteSession(patchbayAgentId, entry.sessionId).catch(() => {});
  }

  private enqueue(patchbayAgentId: PatchbayAgentId, task: () => Promise<void>): Promise<void> {
    const chain = (this.queues.get(patchbayAgentId) ?? Promise.resolve())
      .then(task)
      .catch((err: Error) => this.log.info(`${patchbayAgentId}: defaults editor — ${err.message}`));
    this.queues.set(patchbayAgentId, chain);
    return chain;
  }
}
