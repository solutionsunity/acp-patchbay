import * as vscode from "vscode";

// Condition polling for the electron suite — a probe returning undefined
// keeps waiting; anything else resolves. Replaces fixed sleeps: the test
// waits for the fact it needs, fails loudly at timeout, and runs at the
// speed of the condition instead of the worst-case guess.
export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** What a failed wait on VS Code's active editor adds: VS Code moves the
 * active editor only in a focused window, so an unfocused test window is
 * named as the likely cause — and nothing is claimed when it was focused. */
export function focusNote(): string {
  return vscode.window.state.focused ? "" : " — the test window lost focus; these tests need it focused";
}
