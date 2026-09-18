// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Login executor: runs a terminal-auth recipe — the agent's own binary plus
// the method's args, whether from the `_meta` recipe convention or a typed
// terminal auth method — as a VS Code task and reports the exit code.
//
// A task with a ProcessExecution, not a terminal fed a command string: the
// executable and its args reach VS Code as an array, so nothing here ever
// composes a shell command line. There is no quoting to get right per shell
// (POSIX `'…'`, PowerShell `& '…'`, cmd `"…"` — a POSIX-quoted line pasted
// into PowerShell is a parse error before anything runs), and a path with a
// space, a quote, or a non-ASCII segment reaches the process verbatim on
// every platform. VS Code resolves the executable on Windows itself (a PATHEXT
// walk, so a `.cmd` shim launches through cmd.exe exactly as a spawn would)
// and starts it on a pty: the login prints its URL and reads a pasted code
// from the same pane, and the pane stays open after exit so the output
// survives — the cliff a `shellPath` terminal has. The exit code is the task
// API's own process-end fact, not shell-integration inference.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as vscode from "vscode";
import type { TerminalAuthRecipe } from "./meta";

/** Ad-hoc task type: no `taskDefinitions` contribution — VS Code takes an
 * unregistered type as an opaque identifier, and this task never appears in
 * tasks.json or the Run Task picker. */
const LOGIN_TASK_TYPE = "acpPatchbay.login";

/** How long a task may take to reach its process-start event. A task that
 * fails before its process exists (the engine could not resolve something)
 * is reported to the user by VS Code and then swallowed: `executeTask`
 * still resolves and no end event ever follows. Without a bound the login
 * would wait forever; with it the outcome is honestly "unknown". */
const START_TIMEOUT_MS = 15_000;

/** Runs the recipe front and center and resolves with its exit code —
 * `undefined` only when the answer is honestly unknown: the process never
 * started, or the task ended without its process reporting a code
 * (terminated by the user, terminal closed mid-run).
 *
 * The process runs in the user's home directory. A login is user-scoped —
 * credentials land in the home directory, never the project — and home is
 * the one cwd VS Code permits a task terminal everywhere: omitted, the
 * engine substitutes `${workspaceFolder}`, which a window with no folder
 * open cannot resolve; any other explicit directory is refused in such a
 * window ("cannot launch a terminal process in an empty workspace with cwd
 * different from userHome"). */
export async function runLoginTask(
  name: string,
  recipe: TerminalAuthRecipe,
): Promise<number | undefined> {
  // A per-run id in the definition: VS Code keys task identity on the
  // definition literal, and an identical definition still running would be
  // "already active" (a restart prompt) instead of a second login. It is
  // also what the events are matched on, subscribed before execution so a
  // process that exits in the same beat as it starts cannot be missed.
  const run = randomUUID();
  const task = new vscode.Task(
    { type: LOGIN_TASK_TYPE, run },
    vscode.TaskScope.Global,
    name,
    "Patchbay",
    new vscode.ProcessExecution(recipe.command, recipe.args, { cwd: homedir(), env: recipe.env }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    focus: true,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    showReuseMessage: false,
  };
  const exit = new Promise<number | undefined>((resolve) => {
    const mine = (e: { execution: vscode.TaskExecution }): boolean =>
      e.execution.task.definition.run === run;
    const settle = (code: number | undefined): void => {
      clearTimeout(startWatchdog);
      for (const sub of subs) sub.dispose();
      resolve(code);
    };
    const startWatchdog = setTimeout(() => settle(undefined), START_TIMEOUT_MS);
    const subs = [
      vscode.tasks.onDidStartTaskProcess((e) => {
        if (mine(e)) clearTimeout(startWatchdog);
      }),
      // Process end fires first and carries the code; the task end that
      // follows finds the listeners gone. A task end with no process end
      // before it is the unknown case.
      vscode.tasks.onDidEndTaskProcess((e) => {
        if (mine(e)) settle(e.exitCode);
      }),
      vscode.tasks.onDidEndTask((e) => {
        if (mine(e)) settle(undefined);
      }),
    ];
  });
  await vscode.tasks.executeTask(task);
  return exit;
}
