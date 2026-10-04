import * as vscode from "vscode";

// The one question before an agent's connection ends is a modal, and the
// electron suite has no user to click it: around a call that may put one,
// every modal is answered with its one affirmative choice — the user's
// yes. Other messages go through untouched.
export async function answeringYes<T>(run: () => Promise<T>): Promise<T> {
  const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
  const original = window.showWarningMessage;
  window.showWarningMessage = (...args: unknown[]) => {
    const [, options, choice] = args;
    return (options as { modal?: boolean } | undefined)?.modal === true ? Promise.resolve(choice) : original(...args);
  };
  try {
    return await run();
  } finally {
    window.showWarningMessage = original;
  }
}
