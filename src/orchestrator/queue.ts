// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The queue: when an operation on a row runs — a tool of the orchestrator,
// called only through its gates. Three rules per row:
//  - a request for an operation the row already holds, running or waiting,
//    joins it and gets its outcome;
//  - any other operation takes its turn behind the ones held, in arrival
//    order: it starts once the one before it has settled, however that
//    one settled;
//  - rows never wait on each other.
// What a row holds is the views' busy state for it, so every move is
// reported. Live only — it ends with the window, like the processes it
// orders. A running operation never comes back through here for its own
// row — that request would queue behind it forever; operations compose by
// calling each other directly.

export class Queue<Work extends string> {
  /** Per row, what it holds — the running operation first. */
  private readonly rows = new Map<string, Held<Work>[]>();

  /** `changed` hears every move of a row's holdings. */
  constructor(private readonly changed: (row: string) => void) {}

  /** The row's operations: the running one first, then the ones waiting,
   * in turn order — empty while the row is idle. */
  held(row: string): Work[] {
    return (this.rows.get(row) ?? []).map((h) => h.work);
  }

  /** Runs `body` as `work` on `row` under the three rules; the promise is
   * the operation's outcome, shared by every request that joined it.
   * `identity` is what makes two requests one operation — the work's kind,
   * plus any parameter that changes the outcome. */
  run<T>(row: string, work: Work, body: () => Promise<T>, identity: string = work): Promise<T> {
    const held = this.rows.get(row) ?? [];
    const same = held.find((h) => h.identity === identity);
    // One identity, one body — and so one result type.
    if (same !== undefined) return same.outcome as Promise<T>;
    const turn = held.at(-1)?.settled ?? Promise.resolve();
    const outcome = turn.then(body);
    const entry: Held<Work> = {
      work,
      identity,
      outcome,
      settled: outcome.then(
        () => this.leave(row, entry),
        () => this.leave(row, entry),
      ),
    };
    held.push(entry);
    this.rows.set(row, held);
    this.changed(row);
    return outcome;
  }

  private leave(row: string, entry: Held<Work>): void {
    const held = (this.rows.get(row) ?? []).filter((h) => h !== entry);
    if (held.length === 0) this.rows.delete(row);
    else this.rows.set(row, held);
    this.changed(row);
  }
}

interface Held<Work> {
  work: Work;
  identity: string;
  outcome: Promise<unknown>;
  /** Settles once the operation has left the row — the next one's turn. */
  settled: Promise<void>;
}
