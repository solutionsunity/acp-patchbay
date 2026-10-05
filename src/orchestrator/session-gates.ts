// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The sessions' gates: the one way any door reaches an operation on a
// session's connection — the orchestrator's tool, over two lines per session
// the queue keeps. The attachment line orders what binds the session to its
// connection or rides it between turns: an open's attach (the ladder, the
// zero-turn re-mint with it), a reload, a roots re-apply, a knob set, an
// idle release, a close. The turn line holds the session's turn — one at a
// time, ACP's own rule; held words wait on the session's row and enter the
// line one by one. A turn starts only once the attachment line is idle, so
// nothing re-binds the session under a turn and no prompt fires into a
// replay; a knob set waits for the attachment line only — ACP lets a mode or
// an option change land mid-turn. What a session's own facts allow stays the
// store's to enforce: one turn at a time, never under a standing auth lock.
// What the two lines hold is the session's busy state for the views.
import { randomUUID } from "node:crypto";
import type { QueuedPrompt, SessionWork } from "../shared/protocol";
import { unlessAborted } from "./abort";
import { Cancelled, type Queue } from "./queue";
import type { SessionsStore } from "./sessions-store";

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
  connect(sessionId: string): void;
  /** A failure no door hears — a background attach, a held prompt's turn,
   * an idle release — for the log. */
  failed(context: string, err: unknown): void;
}

export class SessionGates {
  /** Sessions whose root list moved under their running turn: the agent's
   * copy is re-applied once the turn ends, ahead of the next held words. */
  private readonly rootsWaiting = new Set<string>();
  private readonly idleCloseMs: () => number | null;
  private readonly idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessions: SessionsStore,
    private readonly attachLine: Queue<AttachWork>,
    private readonly turnLine: Queue<"prompt">,
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
  busy(sessionId: string): SessionWork[] {
    return [...this.attachLine.held(sessionId), ...this.turnLine.held(sessionId)];
  }

  /** The user opened a session — drawer click, palette pick, "Open in new
   * window", a notification's Open. One ceremony, whatever the entrance:
   * the pointer moves (unless the session is pinned to its own window,
   * which renders it without the pointer), the session attaches, and an
   * off agent is asked for. */
  open(sessionId: string, opts: { pin?: boolean } = {}): void {
    if (opts.pin !== true) this.sessions.point(sessionId);
    void this.attachToView(sessionId);
    this.asks.connect(sessionId);
  }

  /** Points the view at a session and attaches it — no connect: the two
   * entrances that must never spawn a process (the startup restore, "+"
   * focusing a live never-prompted session) come here. */
  activate(sessionId: string): void {
    this.sessions.point(sessionId);
    void this.attachToView(sessionId);
  }

  /** An agent came up: each of its sessions on view sat blank, with nothing
   * to attach to — each attaches now (one already attached costs nothing).
   * Settles once they all have. */
  async reattachViewed(agentId: string): Promise<void> {
    await Promise.all(this.sessions.viewed(agentId).map((sessionId) => this.attachToView(sessionId)));
  }

  /** "New session" for an agent whose never-prompted session lost its
   * connection: the row is still the new session — attached again (the
   * zero-turn rung mints it again, carrying what the user staged) and
   * pointed at. Throws, so the caller's connect pane can say why. */
  async revive(sessionId: string): Promise<void> {
    if (!(await this.attach(sessionId))) throw new Error(`session ${sessionId} could not be attached`);
    this.sessions.point(sessionId);
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
  prompt(sessionId: string, words: Omit<QueuedPrompt, "id">): Promise<void> {
    const running = this.turnLine.held(sessionId).length > 0;
    const locked = this.sessions.locked(sessionId);
    if (running || locked || this.sessions.hasHeld(sessionId)) {
      this.sessions.hold(sessionId, words);
      // Held only by order — words whose release died with an earlier
      // window: the front goes now; this prompt fires after them, one per
      // turn end.
      if (!running && !locked) this.drain(sessionId);
      return Promise.resolve();
    }
    return this.turn(sessionId, words);
  }

  /** Stop: the session's turn ends, and its held words go with it — Stop
   * means stop; draining them after a deliberate stop would restart what
   * the user just ended. Words asked after the Stop go once the stopped
   * turn has wound down. */
  stop(sessionId: string): Promise<void> {
    this.sessions.clearHeld(sessionId);
    return this.turnLine.end(sessionId, "stop");
  }

  /** Reload: the running turn ends — its words kept, if they never reached
   * the wire — and the session is read again from its agent; held words go
   * once it is back. A repeat joins. */
  async reload(sessionId: string): Promise<void> {
    await this.attachLine.run(sessionId, "reload", async (signal) => {
      await this.turnLine.end(sessionId, "reload");
      // The re-attach sends the whole root list: a change the turn held
      // back goes with it.
      this.rootsWaiting.delete(sessionId);
      await this.sessions.reload(sessionId, signal);
    });
    this.drain(sessionId);
  }

  /** Close: everything the session's lines hold ends — its turn told to
   * stop, its attach work dropped — then the session leaves for good. */
  close(sessionId: string): Promise<void> {
    this.rootsWaiting.delete(sessionId);
    return this.attachLine.cut(sessionId, "close", async () => {
      await this.turnLine.end(sessionId, "close");
      await this.sessions.close(sessionId);
    });
  }

  /** A knob set rides the attachment, not the turn: it waits for an
   * attach in flight — never for a turn. A repeat of the same set joins. */
  setKnob(sessionId: string, knobId: string, value: string | boolean): Promise<void> {
    return this.attachLine.run(
      sessionId,
      "knob",
      () => this.sessions.setKnob(sessionId, knobId, value),
      `knob:${knobId}:${String(value)}`,
    );
  }

  async addRoot(sessionId: string, path: string): Promise<void> {
    if (this.sessions.addRoot(sessionId, path)) await this.reapplyRoots(sessionId);
  }

  async removeRoot(sessionId: string, path: string): Promise<void> {
    if (this.sessions.removeRoot(sessionId, path)) await this.reapplyRoots(sessionId);
  }

  /** A workspace folder came or went: every attached session's list moved
   * — its servers told, the agent's copy re-applied, the same rung a
   * user-added root takes. */
  async reapplyWorkspaceRoots(): Promise<void> {
    for (const sessionId of this.sessions.attached()) {
      this.sessions.tellRoots(sessionId);
      await this.reapplyRoots(sessionId);
    }
  }

  /** A login cleared the agent's lock: each of its sessions' held words
   * go. An idle session has no coming turn end to release them — without
   * this, they would wait forever behind a login that already happened. */
  lockCleared(agentId: string): void {
    for (const sessionId of this.sessions.ofAgent(agentId)) this.drain(sessionId);
  }

  /** Ends every session's work — erase, the window's end. */
  endAll(): Promise<void> {
    this.rootsWaiting.clear();
    return Promise.all([this.attachLine.cutAll("close"), this.turnLine.cutAll("close")]).then(() => {});
  }

  /** An open's attach: held words go once the session is attached — opening
   * is their release. A failure is logged: a blank pane and a working
   * Reload are the honest degraded state, never an error at a click. */
  private attachToView(sessionId: string): Promise<void> {
    return this.attach(sessionId).then(
      (attached) => {
        if (attached) this.drain(sessionId);
      },
      (err: unknown) => this.asks.failed(`attach ${sessionId}`, err),
    );
  }

  /** The session attached, if it can be — in the attachment line, an open
   * already there joined; at once when it already is and nothing waits. */
  private attach(sessionId: string): Promise<boolean> {
    if (this.sessions.isLive(sessionId) && this.attachLine.held(sessionId).length === 0) return Promise.resolve(true);
    return this.attachLine.run(sessionId, "open", (signal) => this.sessions.hydrate(sessionId, signal));
  }

  /** One turn on the turn line: the session attached first, then the
   * store's turn. Words that never became a user message are still the
   * user's and go back to the held ones — unless the user's own Stop or
   * Close ended them, which ends them too. However the turn ends, what
   * waited on it goes once it has left the line — but a failed turn holds
   * the words (firing them into whatever just failed would retry a
   * deterministic rejection forever), a stopped one releases only what was
   * asked after the Stop, and a reload or a close takes care of its own. */
  private async turn(sessionId: string, words: Omit<QueuedPrompt, "id"> & { id?: string }): Promise<void> {
    let spent = false;
    try {
      await this.turnLine.run(
        sessionId,
        "prompt",
        async (signal) => {
          await unlessAborted(this.attach(sessionId), signal);
          await this.sessions.runTurn(sessionId, words, signal, () => (spent = true));
        },
        // never joined: each prompt is its own turn
        `prompt:${words.id ?? randomUUID()}`,
        this.attachLine.settled(sessionId),
      );
    } catch (err) {
      const by = err instanceof Cancelled ? err.by : null;
      if (!spent && (by === null || by === "reload")) this.sessions.reHold(sessionId, words);
      // A cut outcome settles at once, ahead of the turn winding down.
      if (by === null) await this.afterTurn(sessionId, false);
      else if (by === "stop") void this.afterTurn(sessionId, true);
      throw err;
    }
    await this.afterTurn(sessionId, true);
  }

  /** What waited on a turn, once it has left the line: a root change made
   * under it first (the next prompt runs on the new list), then — `drain`
   * — the next held words. */
  private async afterTurn(sessionId: string, drain: boolean): Promise<void> {
    await this.turnLine.settled(sessionId);
    if (this.rootsWaiting.delete(sessionId)) {
      await this.reapplyRoots(sessionId).catch((err: unknown) => this.asks.failed(`roots ${sessionId}`, err));
    }
    if (drain) this.drain(sessionId);
  }

  /** The next held words start their turn, if the session can start one —
   * one per call; that turn's own end releases its successor. A turn on
   * the line, a standing lock or an agent not running holds them where they
   * are: words never spend into a connection that cannot take them, and a
   * turn that ended in an error holds them too (nothing calls this after
   * one) — auto-firing into whatever just failed would retry a
   * deterministic rejection forever. */
  private drain(sessionId: string): void {
    if (this.turnLine.held(sessionId).length > 0) return;
    if (!this.sessions.turnAllowed(sessionId)) return;
    const next = this.sessions.takeHeld(sessionId);
    if (next === undefined) return;
    this.turn(sessionId, next).catch((err: unknown) => this.asks.failed(`held prompt ${sessionId}`, err));
  }

  /** The agent's copy of a session's root list, re-applied in the
   * attachment line — or, under a turn, once that turn has ended. Each
   * change its own: one still waiting reads the list as it stands when it
   * runs, but one already running read it before the change. */
  private reapplyRoots(sessionId: string): Promise<void> {
    if (this.turnLine.held(sessionId).length > 0) {
      this.rootsWaiting.add(sessionId);
      return Promise.resolve();
    }
    return this.attachLine.run(
      sessionId,
      "roots",
      (signal) => this.sessions.reapplyRoots(sessionId, signal),
      `roots:${randomUUID()}`,
    );
  }

  /** The resource timer's sweep: a session the store calls idle is
   * released in its attachment line — only when nothing at all is on its
   * lines. */
  private reap(): void {
    const idleCloseMs = this.idleCloseMs();
    if (idleCloseMs === null) return;
    for (const sessionId of this.sessions.idle(idleCloseMs)) {
      if (this.busy(sessionId).length > 0) continue;
      this.attachLine
        .run(sessionId, "release", () => this.sessions.release(sessionId, "idle"))
        .catch((err: unknown) => this.asks.failed(`release ${sessionId}`, err));
    }
  }
}
