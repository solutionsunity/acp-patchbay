// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The sessions' gates: the one way any door reaches an operation on a
// session's connection — the orchestrator's tool, over two lines per session
// the queue keeps. The attachment line orders what binds the session to its
// connection or rides it between turns: an open's attach (the ladder, the
// zero-turn re-mint with it), a reload, a roots re-apply, a knob set, an
// idle release, a delete, a close. The turn line holds the session's turn — one at a
// time, ACP's own rule; held words wait on the session's row and enter the
// line one by one. A turn starts only once the attachment line is idle, so
// nothing re-binds the session under a turn and no prompt fires into a
// replay; a knob set waits for the attachment line only — ACP lets a mode or
// an option change land mid-turn. Every line's work but a delete or a close
// also enters behind what the session's agent's row holds right then — a
// restart, an upgrade, a login — so nothing binds a session to a connection
// being replaced; a delete ends the session's own work first and waits for
// the agent after, since it needs the agent; a close, the escape hatch,
// waits on nothing. What a session's own
// facts allow stays the store's to enforce: one turn at a time, never under a
// standing auth lock. What the two lines hold is the session's busy state for
// the views.
import { randomUUID } from "node:crypto";
import type { QueuedPrompt, SessionWork } from "../shared/protocol";
import { unlessAborted } from "./abort";
import { Cancelled, type Queue } from "./queue";
import type { SessionsStore } from "./sessions-store";
import type { PatchbayAgentId, PatchbaySessionId } from "../shared/ids";

/** The attachment line's work — everything a session's lines hold but its
 * turn. */
export type AttachWork = Exclude<SessionWork, "prompt">;

/** Attached-but-idle sessions release their agent-side resources after an
 * hour — the row stays listed and re-attaches on the next open/prompt. */
const DEFAULT_IDLE_CLOSE_MS = 60 * 60_000;

/** What the gates ask the orchestrator for. */
export interface SessionGateAsks {
  /** Connect on demand: opening a session whose agent may be off asks for
   * it — the orchestrator's agent lifecycle, with its in-pane connect
   * states; a running agent makes it a no-op. When the agent comes up, its
   * sessions on view attach (`reattachViewed`). */
  connect(patchbaySessionId: PatchbaySessionId): void;
  /** A failure no door hears — a background attach, a held prompt's turn,
   * an idle release — for the log. */
  failed(context: string, err: unknown): void;
  /** Settles once the work the agent's row holds now has left it. */
  agentSettled(patchbayAgentId: PatchbayAgentId): Promise<void>;
}

export class SessionGates {
  /** Sessions whose root list moved under their running turn: the agent's
   * copy is re-applied once the turn ends, ahead of the next held words. */
  private readonly rootsWaiting = new Set<string>();
  private readonly idleCloseMs: () => number | null;
  private readonly idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessions: SessionsStore,
    private readonly attachLine: Queue<AttachWork, PatchbaySessionId>,
    private readonly turnLine: Queue<"prompt", PatchbaySessionId>,
    private readonly asks: SessionGateAsks,
    /** `idleCloseMs`: attached sessions idle past this are released
     * (session/close) by the reaper — null disables it entirely. A getter
     * is read fresh on every sweep (store-truth: the orchestrator hands in
     * the Preferences read, so an edit applies to the very next sweep, no
     * reconstruction). */
    opts?: { idleCloseMs?: number | null | (() => number | null) },
  ) {
    const idle = opts?.idleCloseMs === undefined ? DEFAULT_IDLE_CLOSE_MS : opts.idleCloseMs;
    this.idleCloseMs = typeof idle === "function" ? idle : () => idle;
    if (idle !== null) {
      // Static values keep their own cadence (tests run ms-scale timers);
      // a getter sweeps every minute — the setting is minute-grained.
      this.idleTimer = setInterval(() => this.reap(), typeof idle === "number" ? Math.min(60_000, idle) : 60_000);
      this.idleTimer.unref?.();
    }
  }

  dispose(): void {
    if (this.idleTimer !== null) clearInterval(this.idleTimer);
  }

  /** What the session's lines hold — its busy state for the views. */
  busy(patchbaySessionId: PatchbaySessionId): SessionWork[] {
    return [...this.attachLine.held(patchbaySessionId), ...this.turnLine.held(patchbaySessionId)];
  }

  /** The user opened a session — drawer click, palette pick, "Open in new
   * window", a notification's Open. One ceremony, whatever the entrance:
   * the pointer moves (unless the session is pinned to its own window,
   * which renders it without the pointer), the session attaches, and an
   * off agent is asked for. */
  open(patchbaySessionId: PatchbaySessionId, opts: { pin?: boolean } = {}): void {
    if (opts.pin !== true) this.sessions.point(patchbaySessionId);
    void this.attachToView(patchbaySessionId);
    this.asks.connect(patchbaySessionId);
  }

  /** Points the view at a session and attaches it — no connect: the two
   * entrances that must never spawn a process (the startup restore, "+"
   * focusing a live never-prompted session) come here. */
  activate(patchbaySessionId: PatchbaySessionId): void {
    this.sessions.point(patchbaySessionId);
    void this.attachToView(patchbaySessionId);
  }

  /** An agent came up: each of its sessions on view sat blank, with nothing
   * to attach to — each attaches now (one already attached costs nothing).
   * Settles once they all have. */
  async reattachViewed(patchbayAgentId: PatchbayAgentId): Promise<void> {
    await Promise.all(this.sessions.viewed(patchbayAgentId).map((patchbaySessionId) => this.attachToView(patchbaySessionId)));
  }

  /** "New session" for an agent whose never-prompted session lost its
   * connection: the row is still the new session — attached again (the
   * zero-turn rung mints it again, carrying what the user staged) and
   * pointed at. Throws, so the caller's connect pane can say why. */
  async revive(patchbaySessionId: PatchbaySessionId): Promise<void> {
    if (!(await this.attach(patchbaySessionId))) throw new Error(`session ${patchbaySessionId} could not be attached`);
    this.sessions.point(patchbaySessionId);
  }

  /** A prompt: a turn now, or its words held. The turn-start door — the
   * one adjudication every prompt passes, ahead of any transcript write or
   * wire call. Three reasons a turn can't start now, one outcome: the words
   * queue as visible held rows, never silently dropped. A turn on the line
   * (ACP is one prompt per turn) releases them when it ends; a standing
   * auth lock releases them when login evidence clears it (firing under a
   * lock would fabricate a user message the wire is already witnessed to
   * refuse); words already held ahead keep their order — this prompt joins
   * the back. */
  prompt(patchbaySessionId: PatchbaySessionId, words: Omit<QueuedPrompt, "id">): Promise<void> {
    const running = this.turnLine.held(patchbaySessionId).length > 0;
    const locked = this.sessions.locked(patchbaySessionId);
    if (running || locked || this.sessions.hasHeld(patchbaySessionId)) {
      this.sessions.hold(patchbaySessionId, words);
      // Held only by order — words whose release died with an earlier
      // window: the front goes now; this prompt fires after them, one per
      // turn end.
      if (!running && !locked) this.drain(patchbaySessionId);
      return Promise.resolve();
    }
    return this.turn(patchbaySessionId, words);
  }

  /** Stop: the session's turn ends, and its held words go with it — Stop
   * means stop; draining them after a deliberate stop would restart what
   * the user just ended. Words asked after the Stop go once the stopped
   * turn has wound down. */
  stop(patchbaySessionId: PatchbaySessionId): Promise<void> {
    this.sessions.clearHeld(patchbaySessionId);
    return this.turnLine.end(patchbaySessionId, "stop");
  }

  /** Reload: the running turn ends — its words kept, if they never reached
   * the wire — and the session is read again from its agent; held words go
   * once it is back. A repeat joins. */
  async reload(patchbaySessionId: PatchbaySessionId): Promise<void> {
    await this.attachLine.run(
      patchbaySessionId,
      "reload",
      async (signal) => {
        await this.turnLine.end(patchbaySessionId, "reload");
        // The re-attach sends the whole root list: a change the turn held
        // back goes with it.
        this.rootsWaiting.delete(patchbaySessionId);
        await this.sessions.reload(patchbaySessionId, signal);
      },
      "reload",
      this.agentWork(patchbaySessionId),
    );
    this.drain(patchbaySessionId);
  }

  /** Delete: everything the session's lines hold ends — its turn told to
   * stop, its attach work dropped — then, once what its agent's row holds
   * has settled, the agent removes it from its history. An agent that
   * doesn't offer it refuses before anything ends; one that refuses the
   * delete itself leaves the session where it was. */
  async delete(patchbaySessionId: PatchbaySessionId): Promise<void> {
    this.sessions.requireEnd(patchbaySessionId, "delete");
    await this.attachLine.cut(patchbaySessionId, "delete", async () => {
      await this.turnLine.end(patchbaySessionId, "delete");
      await this.agentWork(patchbaySessionId);
      await this.sessions.delete(patchbaySessionId);
      this.rootsWaiting.delete(patchbaySessionId);
    });
  }

  /** Close, where the agent lists no sessions — refused before anything
   * ends anywhere else: everything the session's lines hold ends, then the
   * session leaves for good. It waits on nothing its agent does: a hung
   * restart never keeps a session open. */
  async close(patchbaySessionId: PatchbaySessionId): Promise<void> {
    this.sessions.requireEnd(patchbaySessionId, "close");
    this.rootsWaiting.delete(patchbaySessionId);
    await this.attachLine.cut(patchbaySessionId, "close", async () => {
      await this.turnLine.end(patchbaySessionId, "close");
      await this.sessions.close(patchbaySessionId);
    });
  }

  /** A knob set rides the attachment, not the turn: it waits for an
   * attach in flight — never for a turn. A repeat of the same set joins. */
  setKnob(patchbaySessionId: PatchbaySessionId, knobId: string, value: string | boolean): Promise<void> {
    return this.attachLine.run(
      patchbaySessionId,
      "knob",
      () => this.sessions.setKnob(patchbaySessionId, knobId, value),
      `knob:${knobId}:${String(value)}`,
      this.agentWork(patchbaySessionId),
    );
  }

  async addRoot(patchbaySessionId: PatchbaySessionId, path: string): Promise<void> {
    if (this.sessions.addRoot(patchbaySessionId, path)) await this.reapplyRoots(patchbaySessionId);
  }

  async removeRoot(patchbaySessionId: PatchbaySessionId, path: string): Promise<void> {
    if (this.sessions.removeRoot(patchbaySessionId, path)) await this.reapplyRoots(patchbaySessionId);
  }

  /** A workspace folder came or went: every attached session's list moved
   * — its servers told, the agent's copy re-applied, the same rung a
   * user-added root takes. */
  async reapplyWorkspaceRoots(): Promise<void> {
    for (const patchbaySessionId of this.sessions.attached()) {
      this.sessions.tellRoots(patchbaySessionId);
      await this.reapplyRoots(patchbaySessionId);
    }
  }

  /** A login cleared the agent's lock: each of its sessions' held words
   * go. An idle session has no coming turn end to release them — without
   * this, they would wait forever behind a login that already happened. */
  lockCleared(patchbayAgentId: PatchbayAgentId): void {
    for (const patchbaySessionId of this.sessions.ofAgent(patchbayAgentId)) this.drain(patchbaySessionId);
  }

  /** Ends every session's work — erase, the window's end. */
  endAll(): Promise<void> {
    this.rootsWaiting.clear();
    return Promise.all([this.attachLine.cutAll("close"), this.turnLine.cutAll("close")]).then(() => {});
  }

  /** An open's attach: held words go once the session is attached — opening
   * is their release. A failure is logged: a blank pane and a working
   * Reload are the honest degraded state, never an error at a click. */
  private attachToView(patchbaySessionId: PatchbaySessionId): Promise<void> {
    return this.attach(patchbaySessionId).then(
      (attached) => {
        if (attached) this.drain(patchbaySessionId);
      },
      (err: unknown) => this.asks.failed(`attach ${patchbaySessionId}`, err),
    );
  }

  /** The session attached, if it can be — in the attachment line, an open
   * already there joined; at once when it already is and nothing waits. */
  private attach(patchbaySessionId: PatchbaySessionId): Promise<boolean> {
    if (this.sessions.isLive(patchbaySessionId) && this.attachLine.held(patchbaySessionId).length === 0) return Promise.resolve(true);
    return this.attachLine.run(
      patchbaySessionId,
      "open",
      (signal) => this.sessions.hydrate(patchbaySessionId, signal),
      "open",
      this.agentWork(patchbaySessionId),
    );
  }

  /** One turn on the turn line: the session attached first, then the
   * store's turn. Words that never became a user message are still the
   * user's and go back to the held ones — unless the user's own Stop,
   * Delete or Close ended them, which ends them too. However the turn ends,
   * what waited on it goes once it has left the line — but a failed turn
   * holds the words (firing them into whatever just failed would retry a
   * deterministic rejection forever), a stopped one releases only what was
   * asked after the Stop, and a reload, a delete or a close takes care of
   * its own. */
  private async turn(patchbaySessionId: PatchbaySessionId, words: Omit<QueuedPrompt, "id"> & { id?: string }): Promise<void> {
    let spent = false;
    try {
      await this.turnLine.run(
        patchbaySessionId,
        "prompt",
        async (signal) => {
          await unlessAborted(this.attach(patchbaySessionId), signal);
          await this.sessions.runTurn(patchbaySessionId, words, signal, () => (spent = true));
        },
        // never joined: each prompt is its own turn
        `prompt:${words.id ?? randomUUID()}`,
        Promise.all([this.attachLine.settled(patchbaySessionId), this.agentWork(patchbaySessionId)]),
      );
    } catch (err) {
      const by = err instanceof Cancelled ? err.by : null;
      if (!spent && (by === null || by === "reload")) this.sessions.reHold(patchbaySessionId, words);
      // A cut outcome settles at once, ahead of the turn winding down.
      if (by === null) await this.afterTurn(patchbaySessionId, false);
      else if (by === "stop") void this.afterTurn(patchbaySessionId, true);
      throw err;
    }
    await this.afterTurn(patchbaySessionId, true);
  }

  /** What waited on a turn, once it has left the line: a root change made
   * under it first (the next prompt runs on the new list), then — `drain`
   * — the next held words. */
  private async afterTurn(patchbaySessionId: PatchbaySessionId, drain: boolean): Promise<void> {
    await this.turnLine.settled(patchbaySessionId);
    if (this.rootsWaiting.delete(patchbaySessionId)) {
      await this.reapplyRoots(patchbaySessionId).catch((err: unknown) => this.asks.failed(`roots ${patchbaySessionId}`, err));
    }
    if (drain) this.drain(patchbaySessionId);
  }

  /** The next held words start their turn, if the session can start one —
   * one per call; that turn's own end releases its successor. A turn on
   * the line, a standing lock or an agent not running holds them where they
   * are: words never spend into a connection that cannot take them, and a
   * turn that ended in an error holds them too (nothing calls this after
   * one) — auto-firing into whatever just failed would retry a
   * deterministic rejection forever. */
  private drain(patchbaySessionId: PatchbaySessionId): void {
    if (this.turnLine.held(patchbaySessionId).length > 0) return;
    if (!this.sessions.turnAllowed(patchbaySessionId)) return;
    const next = this.sessions.takeHeld(patchbaySessionId);
    if (next === undefined) return;
    this.turn(patchbaySessionId, next).catch((err: unknown) => this.asks.failed(`held prompt ${patchbaySessionId}`, err));
  }

  /** The agent's copy of a session's root list, re-applied in the
   * attachment line — or, under a turn, once that turn has ended. Each
   * change its own: one still waiting reads the list as it stands when it
   * runs, but one already running read it before the change. */
  private reapplyRoots(patchbaySessionId: PatchbaySessionId): Promise<void> {
    if (this.turnLine.held(patchbaySessionId).length > 0) {
      this.rootsWaiting.add(patchbaySessionId);
      return Promise.resolve();
    }
    return this.attachLine.run(
      patchbaySessionId,
      "roots",
      (signal) => this.sessions.reapplyRoots(patchbaySessionId, signal),
      `roots:${randomUUID()}`,
      this.agentWork(patchbaySessionId),
    );
  }

  /** Settles once the work its agent's row holds right now has left it —
   * what a session's work enters behind. */
  private agentWork(patchbaySessionId: PatchbaySessionId): Promise<void> | undefined {
    const patchbayAgentId = this.sessions.agentFor(patchbaySessionId);
    return patchbayAgentId === undefined ? undefined : this.asks.agentSettled(patchbayAgentId);
  }

  /** The resource timer's sweep: a session the store calls idle is
   * released in its attachment line — only when nothing at all is on its
   * lines. */
  private reap(): void {
    const idleCloseMs = this.idleCloseMs();
    if (idleCloseMs === null) return;
    for (const patchbaySessionId of this.sessions.idle(idleCloseMs)) {
      if (this.busy(patchbaySessionId).length > 0) continue;
      this.attachLine
        .run(patchbaySessionId, "release", () => this.sessions.release(patchbaySessionId, "idle"), "release", this.agentWork(patchbaySessionId))
        .catch((err: unknown) => this.asks.failed(`release ${patchbaySessionId}`, err));
    }
  }
}
