// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Webview-side error collector: uncaught errors, unhandled rejections, and
// CSP violations land in one bounded buffer. The buffer is ephemeral render
// state (render-only-webview: it describes THIS webview instance and dies
// with it); every entry is also forwarded to the orchestrator, whose Output
// channel is the durable record. The ErrorsChip renders the count + copy.
export interface CollectedError {
  at: string; // ISO
  message: string;
}

const MAX = 100;
const buffer: CollectedError[] = [];
const listeners = new Set<() => void>();

let report: (message: string) => void = () => {};

function push(message: string): void {
  buffer.push({ at: new Date().toISOString(), message });
  if (buffer.length > MAX) buffer.shift();
  report(message);
  for (const l of listeners) l();
}

export function installErrorCollector(reportToHost: (message: string) => void): void {
  report = reportToHost;
  window.addEventListener("error", (e) => {
    push(e.message || String(e.error ?? "unknown error"));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r: unknown = e.reason;
    push(`unhandled rejection: ${r instanceof Error ? r.message : String(r)}`);
  });
  window.addEventListener("securitypolicyviolation", (e) => {
    push(`CSP blocked ${e.violatedDirective}: ${e.blockedURI || e.sourceFile || "inline"}`);
  });
}

export function subscribeErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function collectedErrors(): readonly CollectedError[] {
  return buffer;
}
