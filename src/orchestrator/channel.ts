// Host side of one webview channel: canonical state + revision counter + patch
// bus. vscode-free (structural WebviewLike) so the whole state machine is
// unit-testable; the vscode glue lives in webview-host.ts.
import type {
  Action,
  CoalesceHook,
  HostToView,
  ViewToHost,
} from "../shared/protocol";
import { CoalescingBus } from "./bus";

export interface WebviewLike {
  postMessage(message: unknown): Thenable<boolean>;
}

/** The state-agnostic face a webview binding needs (see webview-host.ts). */
export interface ChannelEndpoint {
  attach(view: WebviewLike): void;
  detach(view: WebviewLike): void;
  handleViewMessage(msg: ViewToHost): void;
}

export class ChannelHost<S, E> {
  private state: S;
  private rev = 0;
  private view: WebviewLike | null = null;
  private lastAckedRev = -1;
  private readonly bus: CoalescingBus<E>;
  private ackWaiters: Array<{ rev: number; resolve: (rev: number) => void }> = [];
  private changeListeners = new Set<() => void>();

  constructor(
    initial: S,
    private readonly reduce: (state: S, event: E) => S,
    coalesce: CoalesceHook<E>,
    private readonly onAction: (action: Action) => void,
    intervalMs?: number,
  ) {
    this.state = initial;
    this.bus = new CoalescingBus<E>(
      (events) => this.sendPatch(events),
      coalesce,
      intervalMs,
    );
  }

  /** Canonical state — always current, independent of webview lifecycle. */
  get current(): S {
    return this.state;
  }

  get revision(): number {
    return this.rev;
  }

  /** Advance canonical state and schedule the patch. */
  emit(...events: E[]): void {
    for (const event of events) {
      this.state = this.reduce(this.state, event);
      this.bus.emit(event);
    }
    for (const listener of this.changeListeners) listener();
  }

  /** Native surfaces (status bar, P11) need to react to canonical state
   * without being a webview — independent of the single `view` attachment
   * above, and of the coalesced patch stream. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  flushNow(): void {
    this.bus.flushNow();
  }

  attach(view: WebviewLike): void {
    this.view = view;
    this.lastAckedRev = -1;
  }

  detach(view: WebviewLike): void {
    if (this.view === view) {
      this.view = null;
      this.lastAckedRev = -1;
    }
  }

  handleViewMessage(msg: ViewToHost): void {
    switch (msg.kind) {
      case "ready":
      case "resnapshot":
        this.sendSnapshot();
        break;
      case "applied":
        this.lastAckedRev = msg.rev;
        this.ackWaiters = this.ackWaiters.filter((w) => {
          if (msg.rev >= w.rev) {
            w.resolve(msg.rev);
            return false;
          }
          return true;
        });
        break;
      case "action":
        this.onAction(msg.action);
        break;
    }
  }

  /** Resolves when the attached webview has acked the given revision (default: current). */
  waitForApplied(rev: number = this.rev): Promise<number> {
    if (this.lastAckedRev >= rev) return Promise.resolve(this.lastAckedRev);
    return new Promise((resolve) => this.ackWaiters.push({ rev, resolve }));
  }

  private sendSnapshot(): void {
    if (this.view === null) return;
    // Buffered events are already folded into canonical state — a patch after
    // this snapshot would double-apply them. Recovery is always "resnapshot".
    this.bus.discard();
    const msg: HostToView<S, E> = {
      kind: "snapshot",
      rev: this.rev,
      state: this.state,
    };
    void this.view.postMessage(msg);
  }

  private sendPatch(events: E[]): void {
    this.rev += 1;
    if (this.view === null) return; // canonical rev still advances; remount resnapshots
    const msg: HostToView<S, E> = { kind: "patch", rev: this.rev, events };
    void this.view.postMessage(msg);
  }
}
