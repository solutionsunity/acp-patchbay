// Issue #65: the editor installs a newer patchbay beside the running one
// and tells the running one nothing — no extension event, and the API keeps
// answering with the running copy. Patchbay reads the extensions folder
// instead and says the newer copy waits for a reload. Here patchbay runs as
// a user has it, installed from a .vsix into the editor's extensions
// folder, and the newer .vsix is installed while it runs. What patchbay
// says is read from its log, where every notice is written as it shows:
// another extension can't intercept patchbay's notifications.
import * as assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as vscode from "vscode";
import { name, publisher } from "../../../package.json";
import { filesUnder } from "../../support/source-files";
import { waitFor } from "../../support/wait-for";

const DIR = resolve(__dirname, "..", "..", "..", "self-update");
const ID = `${publisher}.${name}`;
/** An install, and the extension host taking it in. */
const INSTALL_SETTLE = 30_000;

/** Patchbay's log file, found under this run's logs — undefined until it
 * exists. */
function patchbayLog(): string | undefined {
  const logs = join(DIR, "user-data", "logs");
  return existsSync(logs) ? filesUnder(logs, /^Patchbay\.log$/)[0] : undefined;
}

/** The notices patchbay has shown, in order. */
function notices(log: string): string[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .flatMap((line) => /self version: (.*)$/.exec(line)?.[1] ?? []);
}

const install = (vsix: string) => vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(join(DIR, vsix)));

suite("self update", () => {
  test("a running patchbay sees a newer copy installed beside it and says to reload", async function () {
    this.timeout(120_000);
    const versions = JSON.parse(readFileSync(join(DIR, "versions.json"), "utf8")) as { running: string; newer: string };

    await install("running.vsix");
    const ext = await waitFor(() => vscode.extensions.getExtension(ID), INSTALL_SETTLE, "patchbay installed");
    await ext.activate();
    const log = await waitFor(patchbayLog, INSTALL_SETTLE, "patchbay's log");
    // a fresh profile, no agent: a fresh install
    await waitFor(() => notices(log).length > 0, INSTALL_SETTLE, "the start's notice");
    assert.deepStrictEqual(notices(log), ["Patchbay is installed — it chats with any ACP agent you add."]);

    await install("newer.vsix");
    const waiting = `Patchbay ${versions.newer} is installed — reload the window to use it. Reloading stops the agents running in this window.`;
    await waitFor(() => notices(log).includes(waiting), INSTALL_SETTLE, () => `the reload notice (said: ${JSON.stringify(notices(log))})`);
    // the editor told the running copy nothing — it is still the one asked
    assert.strictEqual(vscode.extensions.getExtension(ID)?.packageJSON.version, versions.running);

    // the install's later writes say nothing again
    await new Promise((settle) => setTimeout(settle, 2_000));
    assert.deepStrictEqual(notices(log), ["Patchbay is installed — it chats with any ACP agent you add.", waiting]);
  });
});
