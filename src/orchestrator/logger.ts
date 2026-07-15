// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// vscode-free logging seam: the orchestrator injects VS Code's
// LogOutputChannel (the "Patchbay" Output channel — its methods satisfy this
// shape structurally); everything below the orchestrator stays
// vscode-free/unit-testable and defaults to silence.
//
// no-secret-exposure.md applies to logs: never argv contents or env *values*
// (users embed keys in args and URLs) — executables, env key *names*, hosts,
// ids, and counts only.
export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const nullLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A URL reduced to what's safe to log — host only; paths and query strings
 * can embed tokens (per-account MCP endpoints, signed URLs). */
export function loggableUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparsable url>";
  }
}
