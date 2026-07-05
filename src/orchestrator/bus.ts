// Patch bus: buffers high-frequency events and flushes one patch per short
// fixed interval or explicit boundary. One knob, no adaptive machinery
// (architecture.md § Snapshot + patch protocol).
import type { CoalesceHook } from "../shared/protocol";

export const FLUSH_INTERVAL_MS = 30;

export class CoalescingBus<E> {
  private buffer: E[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flush: (events: E[]) => void,
    private readonly coalesce: CoalesceHook<E>,
    private readonly intervalMs: number = FLUSH_INTERVAL_MS,
  ) {}

  emit(event: E): void {
    const last = this.buffer[this.buffer.length - 1];
    if (last !== undefined) {
      const merged = this.coalesce(last, event);
      if (merged !== null) {
        this.buffer[this.buffer.length - 1] = merged;
        return;
      }
    }
    this.buffer.push(event);
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flushNow(), this.intervalMs);
    }
  }

  /** Flush immediately (turn boundary, snapshot request, disposal). */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    this.flush(events);
  }

  /** Drop buffered events (they are already folded into a snapshot being sent). */
  discard(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }
}
