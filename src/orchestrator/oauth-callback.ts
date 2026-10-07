// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Pending-OAuth-callback registry, keyed by the `state` parameter. The
// vscode glue is one line in extension.ts: registerUriHandler routes every
// incoming `vscode://solutionsunity.acp-patchbay/...` URI's query string to
// `handle()`. Kept vscode-free so flow tests can drive callbacks directly.
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
    waiter(params);
    return true;
  }
}
