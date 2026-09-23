// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Saved roots — the folders every new session starts with, beyond the
// workspace's own. One class, two instances by scope: "workspace" over
// workspaceState (per user, per workspace, never repo-shipped) and
// "machine" over the machine store (every workspace on this machine). A
// preference, not a session fact: a session owns its list once born, so
// nothing stored here ever reaches a live session.
import type { SavedRootScope } from "../../shared/protocol";
import type { KV } from "./kv";

const KEYS: Record<SavedRootScope, string> = {
  workspace: "acpPatchbay.savedRoots",
  machine: "acpPatchbay.machineSavedRoots",
};

export class SavedRootsStore {
  private readonly key: string;

  constructor(
    private readonly kv: KV,
    scope: SavedRootScope,
  ) {
    this.key = KEYS[scope];
  }

  list(): string[] {
    return this.kv.get<string[]>(this.key) ?? [];
  }

  async add(path: string): Promise<void> {
    const current = this.list();
    if (!current.includes(path)) await this.kv.update(this.key, [...current, path]);
  }

  /** In place — the list's order is the user's. */
  async replace(path: string, next: string): Promise<void> {
    const current = this.list();
    await this.kv.update(
      this.key,
      current.includes(next) ? current.filter((p) => p !== path) : current.map((p) => (p === path ? next : p)),
    );
  }

  async remove(path: string): Promise<void> {
    await this.kv.update(
      this.key,
      this.list().filter((p) => p !== path),
    );
  }

  async wipe(): Promise<void> {
    await this.kv.update(this.key, undefined);
  }
}
