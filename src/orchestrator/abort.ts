// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Waiting on work a signal may end first — the wait ends, the work doesn't.

/** `work`'s outcome — or the signal's reason the moment it aborts, `work`
 * left to run on unwatched: whatever it settles to then is no one's to
 * hear. */
export function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
