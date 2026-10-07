// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The queue: when an operation on a row runs — a tool of the orchestrator,
// called only through its gates. Per row:
//  - a request for an operation the row holds, running or waiting, joins
//    it and gets its outcome;
//  - any other operation takes its turn: it starts once everything held
//    before it has left the row, however each one settled;
//  - an operation that cuts in first ends the row's work: the running one
//    is told to stop and the waiting ones are dropped, each settling as
//    Cancelled at once — and the one that cut in takes its turn when what
//    is left of them has unwound. What cuts in is never cut: it is how
//    work ends;
//  - rows wait on each other only where a caller says so: an operation can
//    take its turn after work elsewhere has settled too (`after`).
// What a row holds is the views' busy state for it, so every move is
// reported. Live only — it ends with the window, like the processes it
// orders. A running operation never comes back through here for its own
// row — that request would queue behind it forever; operations compose by
// calling each other directly.

/** How an operation the queue cut settles — `by` is the operation that cut
 * it. */
export class Cancelled extends Error {
  constructor(readonly by: string) {
    super(`cancelled by ${by}`);
    this.name = "Cancelled";
  }
}

export class Queue<Work extends string, Row extends string = string> {
  /** Per row, what it holds — the running operations first. */
  private readonly rows = new Map<Row, Held<Work>[]>();

  /** `changed` hears every move of a row's holdings. */
  constructor(private readonly changed: (row: Row) => void) {}

  /** The row's operations: the running ones first, then the ones waiting,
   * in turn order — empty while the row is idle. */
  held(row: Row): Work[] {
    return (this.rows.get(row) ?? []).map((h) => h.work);
  }

  /** Whether the row holds work told to stop and still winding down —
   * cut, but not yet left. */
  windingDown(row: Row): boolean {
    return (this.rows.get(row) ?? []).some((h) => h.signal.aborted);
  }

  /** Every row holding work now. */
  holding(): Row[] {
    return [...this.rows.keys()];
  }

  /** Runs `body` as `work` on `row` in its turn; the promise is the
   * operation's outcome, shared by every request that joined it.
   * `identity` is what makes two requests one operation — the work's kind,
   * plus any parameter that changes the outcome. `body` gets the signal a
   * cut aborts: told to stop, a running operation ends there. `after` is
   * work elsewhere its turn waits for too. */
  run<T>(
    row: Row,
    work: Work,
    body: (signal: AbortSignal) => Promise<T>,
    identity: string = work,
    after?: Promise<unknown>,
  ): Promise<T> {
    return this.enter(row, work, identity, body, false, after);
  }

  /** Ends the row's work, then runs `body` as `work` once what it cut, and
   * any cut-in held before it, has left the row. Its signal never aborts. */
  cut<T>(
    row: Row,
    work: Work,
    body: (signal: AbortSignal) => Promise<T>,
    identity: string = work,
  ): Promise<T> {
    return this.enter(row, work, identity, body, true);
  }

  /** Ends the row's work as `by` cutting in would, and runs nothing after:
   * settles once all of it has left. */
  end(row: Row, by: string): Promise<void> {
    const held = [...(this.rows.get(row) ?? [])];
    for (const h of held) h.cancel(by);
    return Promise.all(held.map((h) => h.left)).then(() => {});
  }

  /** Ends every row's work, as `by` would cutting in on each; settles once
   * all of it has left. */
  cutAll(by: string): Promise<void> {
    return Promise.all([...this.rows.keys()].map((row) => this.end(row, by))).then(() => {});
  }

  /** Settles once everything the row holds now has left it — what an
   * operation elsewhere waits for (`after`). */
  settled(row: Row): Promise<void> {
    return Promise.all((this.rows.get(row) ?? []).map((h) => h.left)).then(() => {});
  }

  private enter<T>(
    row: Row,
    work: Work,
    identity: string,
    body: (signal: AbortSignal) => Promise<T>,
    cuts: boolean,
    after?: Promise<unknown>,
  ): Promise<T> {
    const held = this.rows.get(row) ?? [];
    // One already cut is no longer the operation being asked for.
    const same = held.find((h) => h.identity === identity && !h.signal.aborted);
    // One identity, one body — and so one result type.
    if (same !== undefined) return same.outcome as Promise<T>;
    if (cuts) for (const h of held) h.cancel(work);
    const turn = Promise.all([...held.map((h) => h.left), after]);
    const controller = new AbortController();
    const { signal } = controller;
    let started = false;
    const ran = turn.then(() => {
      signal.throwIfAborted();
      started = true;
      return body(signal);
    });
    const left = new Promise<void>((resolve) => {
      ran.then(() => resolve(), () => resolve());
      // Dropped before its turn: it leaves now, and never runs.
      signal.addEventListener(
        "abort",
        () => {
          if (!started) resolve();
        },
        { once: true },
      );
    }).then(() => this.leave(row, entry));
    const entry: Held<Work> = {
      work,
      identity,
      signal,
      // Heard once the operation has left the row — or, cut, at once: what
      // is left of a running body unwinds before the next turn.
      outcome: new Promise<T>((resolve, reject) => {
        ran.then(
          (value) => left.then(() => resolve(value)),
          (err: unknown) => left.then(() => reject(err)),
        );
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
      cancel: (by) => {
        if (cuts || signal.aborted) return;
        controller.abort(new Cancelled(by));
        // A running one told to stop is a move of the row's holdings too:
        // it winds down, and reads that way. One dropped before its turn
        // leaves at once — that is its move.
        if (started) this.changed(row);
      },
      left,
    };
    held.push(entry);
    this.rows.set(row, held);
    this.changed(row);
    return entry.outcome as Promise<T>;
  }

  private leave(row: Row, entry: Held<Work>): void {
    const held = (this.rows.get(row) ?? []).filter((h) => h !== entry);
    if (held.length === 0) this.rows.delete(row);
    else this.rows.set(row, held);
    this.changed(row);
  }
}

interface Held<Work> {
  work: Work;
  identity: string;
  /** Aborts when the operation is cut. */
  signal: AbortSignal;
  outcome: Promise<unknown>;
  /** Ends the operation, `by` cutting in — nothing for one that cut in
   * itself. */
  cancel(by: string): void;
  /** Settles once the operation has left the row. */
  left: Promise<void>;
}
