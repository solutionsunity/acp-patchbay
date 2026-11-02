// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Pending-OAuth-callback registry, keyed by the `state` parameter. The
// vscode glue is one line in extension.ts: registerUriHandler routes every
// incoming `vscode://solutionsunity.acp-patchbay/...` URI to the
// orchestrator, which hands its query string to `handle()`. Kept
// vscode-free so flow tests can drive callbacks directly.

/** What became of a callback: handed to the sign-in waiting on its state;
 * carrying a state no sign-in here waits on (another window's, or one that
 * ended — the two read the same); or carrying none, so no sign-in's. */
export type CallbackOutcome = "delivered" | "not waiting" | "not a callback";

export class OAuthCallbackRegistry {
  private pending = new Map<string, (params: URLSearchParams) => void>();

  /** Resolves when a callback carrying this `state` arrives — however long
   * the user takes in the browser (a sign-in can hold an MFA prompt, a
   * password reset, an organization's approval). The wait ends with its
   * attempt: the attempt's signal (Cancel, the window's end) drops the
   * pending callback and rejects with the signal's reason, so a tab
   * finished later finds nothing waiting. */
  wait(state: string, signal?: AbortSignal): Promise<URLSearchParams> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(state);
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(state, (params) => {
        signal?.removeEventListener("abort", abort);
        resolve(params);
      });
    });
  }

  /** Feed an incoming callback URI's query string. */
  handle(query: string): CallbackOutcome {
    const params = new URLSearchParams(query);
    const state = params.get("state");
    if (state === null) return "not a callback";
    const waiter = this.pending.get(state);
    if (waiter === undefined) return "not waiting";
    this.pending.delete(state);
    waiter(params);
    return "delivered";
  }
}
