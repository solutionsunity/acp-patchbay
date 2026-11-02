// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Patchbay's word on its own version, said where VS Code can say it: a
// notice with one action for each moment self-version.ts finds — a fresh
// install, an update, a newer copy installed beside this one. It looks once
// the window's stores are ready and again whenever the extensions folder
// changes: the editor installs a newer copy without telling the one that
// runs. Each moment is said once in a window; the version a start
// announces is recorded, so other windows starting on it say nothing.
import { type FSWatcher, readdirSync, readFileSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import { selfVersionMoments, type SelfVersionFacts, type SelfVersionMoment } from "./self-version";
import type { SeenVersionStore } from "./stores/seen-version";

const ADD_AGENT = "Add your first agent";
const WHATS_NEW = "What's new";
const RELOAD = "Reload Window";

export interface SelfVersionDeps {
  seenVersion: SeenVersionStore;
  hasAgents(): boolean;
  openAgentsSettings(): void;
  log: vscode.LogOutputChannel;
}

export class SelfVersionHost implements vscode.Disposable {
  /** The moments said in this window, by kind and version. */
  private readonly said = new Set<string>();
  private watcher: FSWatcher | null = null;
  /** Gone before the first look ran — a window closed at once. */
  private disposed = false;

  constructor(
    private readonly extension: vscode.Extension<unknown>,
    /** Only an installed copy sits in the editor's extensions folder; a
     * development copy runs from its own, with nothing beside it to watch. */
    private readonly installed: boolean,
    private readonly deps: SelfVersionDeps,
  ) {}

  start(): void {
    if (this.disposed) return;
    this.look();
    if (!this.installed) return;
    try {
      this.watcher = watch(dirname(this.extension.extensionPath), () => this.look());
      this.watcher.on("error", (error) => this.deps.log.info(`self version: the extensions folder can't be watched — ${String(error)}`));
    } catch (error) {
      this.deps.log.info(`self version: the extensions folder can't be watched — ${String(error)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
  }

  private look(): void {
    const moments = selfVersionMoments({
      id: this.extension.id,
      // The manifest the editor loaded this copy from — the version it
      // named this copy's folder by, weighed against the folders beside it.
      running: (this.extension.packageJSON as { version: string }).version,
      seen: this.deps.seenVersion.get(),
      hasAgents: this.deps.hasAgents(),
      disk: this.readDisk(),
    });
    for (const moment of moments) {
      const key = `${moment.kind}@${moment.version}`;
      if (this.said.has(key)) continue;
      this.said.add(key);
      if (moment.kind !== "waiting") {
        void this.deps.seenVersion.record(moment.version).then(undefined, (error: unknown) =>
          this.deps.log.info(`self version: ${moment.version} not recorded — ${String(error)}`),
        );
      }
      void this.say(moment);
    }
  }

  /** The folder this copy runs from, read as it stands — null when it
   * can't be listed. A `.obsolete` missing or mid-write reads as none. */
  private readDisk(): SelfVersionFacts["disk"] {
    const dir = dirname(this.extension.extensionPath);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    let obsolete: unknown = null;
    try {
      obsolete = JSON.parse(readFileSync(join(dir, ".obsolete"), "utf8"));
    } catch {
      // none, or not whole yet — the write that completes it is seen too
    }
    return { folder: basename(this.extension.extensionPath), obsolete, names };
  }

  private async say(moment: SelfVersionMoment): Promise<void> {
    switch (moment.kind) {
      case "installed":
        if ((await this.notice("Patchbay is installed — it chats with any ACP agent you add.", ADD_AGENT)) === ADD_AGENT) {
          this.deps.openAgentsSettings();
        }
        return;
      case "updated":
        if ((await this.notice(`Patchbay updated to ${moment.version}.`, WHATS_NEW)) === WHATS_NEW) await this.showChangelog();
        return;
      case "waiting":
        if (
          (await this.notice(
            `Patchbay ${moment.version} is installed — reload the window to use it. Reloading stops the agents running in this window.`,
            RELOAD,
          )) === RELOAD
        ) {
          // Not `workbench.action.restartExtensionHost`: a bare restart
          // starts the copy already loaded again, never the newer one.
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
    }
  }

  private notice(message: string, action: string): Thenable<string | undefined> {
    this.deps.log.info(`self version: ${message}`);
    return vscode.window.showInformationMessage(message, action);
  }

  /** The changelog shipped inside this copy, as a Markdown preview — the
   * file itself where no preview exists. The packager lowercases its name,
   * so it is found by name in any case. */
  private async showChangelog(): Promise<void> {
    const name = (await readdir(this.extension.extensionPath)).find((n) => n.toLowerCase() === "changelog.md");
    if (name === undefined) {
      this.deps.log.info(`self version: no changelog in ${this.extension.extensionPath}`);
      return;
    }
    const uri = vscode.Uri.joinPath(this.extension.extensionUri, name);
    await vscode.commands.executeCommand("markdown.showPreview", uri).then(undefined, () => vscode.window.showTextDocument(uri));
  }
}
