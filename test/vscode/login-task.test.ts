// Login executor against the real task engine (@vscode/test-electron): the
// recipe's args must reach the process verbatim — no shell command line is
// composed on our side, so a space, a quote, a backslash path, or non-ASCII
// text needs no per-shell quoting — and the exit code must be the process's
// own. On Windows this is the run that catches the PowerShell parse error
// a POSIX-quoted command line produces (issue #4); on POSIX it pins the
// same contract.
import * as assert from "node:assert";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

interface Internal {
  runLoginTask(
    name: string,
    recipe: { command: string; args: string[]; env?: Record<string, string> },
  ): Promise<number | undefined>;
}

async function internal(): Promise<Internal> {
  const ext = vscode.extensions.getExtension("solutionsunity.acp-patchbay");
  assert.ok(ext);
  const api = (await ext.activate()) as { internal: Internal };
  return api.internal;
}

suite("login task executor", () => {
  let dir: string;
  suiteSetup(async () => {
    dir = await mkdtemp(join(tmpdir(), "patchbay-login-task-"));
  });
  suiteTeardown(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("args reach the process verbatim and the exit code is the process's own", async () => {
    const out = join(dir, "argv.json");
    const payload = [
      "has a space",
      "it's quoted",
      "C:\\Users\\O'Brien\\x y",
      "جغرافيا طبيعية",
      "$HOME `whoami` %PATH%",
    ];
    const script =
      "require('fs').writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));" +
      "process.exit(Number(process.env.PATCHBAY_LOGIN_EXIT))";
    const { runLoginTask } = await internal();
    const code = await runLoginTask("login-task test", {
      command: "node",
      args: ["-e", script, out, ...payload],
      env: { PATCHBAY_LOGIN_EXIT: "7" },
    });
    assert.strictEqual(code, 7, "exit code is the task's process-end fact");
    const seen = JSON.parse(await readFile(out, "utf8")) as { args: string[]; cwd: string };
    assert.deepStrictEqual(seen.args, payload);
    // Home is the cwd: the test host has no folder open, which is exactly
    // the window VS Code refuses any other task cwd in.
    assert.strictEqual(await realpath(seen.cwd), await realpath(homedir()));
  });
});
