// A webview action that fails says so where the user is: through the real
// dispatcher, with the real notification call, on what the user asked for.
import { join } from "node:path";
import * as vscode from "vscode";
import type { Orchestrator } from "../../src/orchestrator/orchestrator";
import { WINDOW_SETTLE, waitFor } from "../support/wait-for";
import { internals, Patchbay } from "./patchbay";

suite("a failed action", () => {
  const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
  let original: typeof window.showWarningMessage;
  let shown: string[];

  setup(() => {
    original = window.showWarningMessage;
    shown = [];
    window.showWarningMessage = (...args: unknown[]) => {
      shown.push(String(args[0]));
      return Promise.resolve(undefined);
    };
  });
  teardown(() => {
    window.showWarningMessage = original;
  });

  test("a file that isn't there: says it didn't open", async () => {
    (await Patchbay.open()).act({ kind: "openFile", path: join(__dirname, "no-such-file.txt") });
    await waitFor(() => shown.some((s) => s.startsWith("The file didn't open — ")), WINDOW_SETTLE, "the warning");
  });

  test("a command rule whose save fails: says it wasn't saved, and why", async () => {
    const { orchestrator } = await internals<{ orchestrator: Orchestrator }>();
    const setCommandRules = orchestrator.setCommandRules.bind(orchestrator);
    orchestrator.setCommandRules = () => Promise.reject(new Error("disk full"));
    try {
      (await Patchbay.open()).act({
        kind: "addCommandRule",
        layer: "machine",
        rule: { kind: "prefix", pattern: "ls", verdict: "allow" } as never,
      });
      await waitFor(() => shown.includes("The command rule wasn't saved — disk full"), WINDOW_SETTLE, "the warning");
    } finally {
      orchestrator.setCommandRules = setCommandRules;
    }
  });
});
