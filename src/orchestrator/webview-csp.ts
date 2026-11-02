// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The content security policy every webview page runs under — and the UI
// gate's pages too, so what the gate passes is what a webview allows. No
// eval, no inline script, no network: a page starts one script by its
// nonce, which may load its own siblings, and reads styles, images and
// fonts from where its own files are served. It is never widened silently:
// a test pins every directive, so a change here is a change there too.
// Imports nothing, so the gate's plain script can load it as it is.

/** The policy for a page whose files are served from `source` and whose
 * one starting script carries `nonce`. */
export function webviewCsp(source: string, nonce: string): string {
  return [
    "default-src 'none'",
    `style-src ${source} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `img-src ${source} data:`,
    `font-src ${source}`,
  ].join("; ") + ";";
}
