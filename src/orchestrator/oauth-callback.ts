// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Pending-OAuth-callback registry, keyed by the `state` parameter. The
// vscode glue is one line in extension.ts: registerUriHandler routes every
// incoming `vscode://solutionsunity.acp-patchbay/...` URI's query string to
// `handle()`. Kept vscode-free so flow tests can drive callbacks directly.
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000; // user is off in a browser — generous, not infinite

export class OAuthCallbackRegistry {
  private pending = new Map<
    string,
    { resolve(params: URLSearchParams): void; reject(err: Error): void; timer: NodeJS.Timeout }
  >();

  /** Resolves when a callback carrying this `state` arrives; rejects on
   * timeout so an abandoned browser tab can't leave a connect card
   * spinning forever. */
  wait(state: string, timeoutMs = CALLBACK_TIMEOUT_MS): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(state);
        reject(new Error("authorization timed out — no callback received"));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(state, { resolve, reject, timer });
    });
  }

  /** Feed an incoming callback URI's query string. Returns false for URIs
   * that aren't a pending OAuth callback (unknown/absent state) — the
   * handler ignores them rather than erroring, since the extension's URI
   * namespace may carry other traffic someday. */
  handle(query: string): boolean {
    const params = new URLSearchParams(query);
    const state = params.get("state");
    if (state === null) return false;
    const waiter = this.pending.get(state);
    if (waiter === undefined) return false;
    this.pending.delete(state);
    clearTimeout(waiter.timer);
    waiter.resolve(params);
    return true;
  }
}
