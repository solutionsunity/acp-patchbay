// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Saved roots — the folders new sessions start with, beyond the workspace's
// own: one list in the machine store, each folder with the workspaces it is
// saved for (every one, these, or every one but these). Kept in the machine
// store so any window can show and change where a folder is saved, not only
// the workspace's own. A preference, not a session fact: a session owns its
// list once born, so nothing stored here ever reaches a live session.
import { z } from "zod";
import { ownReach, reaches, withOne, type Reach } from "../../shared/reach";
import type { WorkspaceId } from "../../shared/workspace";
import type { KV, StoredEntry } from "./kv";
import { reachSchema } from "./reach-schema";
import { STORAGE_KEYS } from "./storage-keys";

const entrySchema = z.object({
  path: z.string().min(1),
  workspaces: reachSchema<WorkspaceId>(),
});
export type SavedRoot = z.infer<typeof entrySchema>;

const KEY = STORAGE_KEYS.savedRoots;

export class SavedRootsStore implements StoredEntry {
  readonly key = KEY;

  constructor(
    private readonly kv: KV,
    /** The window's workspace and its own store — absent where there is no
     * window (an import's file), null in a window with no workspace. */
    private readonly workspace: { id: WorkspaceId; kv: KV } | null = null,
  ) {
    // Once, at construction: the folders an earlier version saved for every
    // workspace are copied, never moved — a window still on that version
    // keeps its own key — each saved for every workspace, as it was.
    // Anything else in the list is copied as it is, and reads as nothing.
    const earlier = kv.get<unknown>(STORAGE_KEYS.savedRootsBefore090);
    if (kv.get<unknown>(KEY) === undefined && Array.isArray(earlier)) {
      void kv.update(
        KEY,
        earlier.map((path: unknown) => (typeof path === "string" ? { path, workspaces: "auto" } : path)),
      );
    }
    // Once per workspace, at construction: its own folders, kept by an
    // earlier version in its workspaceState where only its window could
    // read them, join the list for it — saved here first, then cleared
    // there.
    const own = workspace?.kv.get<unknown>(STORAGE_KEYS.workspaceSavedRootsBefore090);
    if (workspace !== null && own !== undefined) {
      let entries = this.list();
      for (const path of Array.isArray(own) ? own : []) {
        if (typeof path === "string" && path !== "") entries = saved(entries, path, workspace.id);
      }
      void kv.update(KEY, entries).then(() => workspace.kv.update(STORAGE_KEYS.workspaceSavedRootsBefore090, undefined));
    }
  }

  stored(): unknown {
    return this.kv.get(this.key);
  }

  /** Every stored entry that reads as one: anything else is skipped. */
  list(): SavedRoot[] {
    const stored = this.kv.get<unknown>(this.key);
    if (!Array.isArray(stored)) return [];
    return stored.flatMap((e) => {
      const read = entrySchema.safeParse(e);
      return read.success ? [read.data] : [];
    });
  }

  /** The folders saved for workspace `here` (null: a window with no
   * workspace) — what a new session there starts with. */
  pathsFor(here: WorkspaceId | null): string[] {
    return this.list()
      .filter((e) => reaches(e.workspaces, here))
      .map((e) => e.path);
  }

  /** Saved for `here` too, or — `here` "auto" — for every workspace; a
   * folder not saved yet joins the list's end. */
  async save(path: string, here: WorkspaceId | "auto"): Promise<void> {
    await this.rewrite((current) => saved(current, path, here));
  }

  /** Where a folder is saved, as chosen in Settings. */
  async setWorkspaces(path: string, workspaces: Reach<WorkspaceId>): Promise<void> {
    await this.rewrite((current) => current.map((e) => (e.path === path ? { path, workspaces: ownReach(workspaces) } : e)));
  }

  /** In place, where it is saved kept — the list's order is the user's. A
   * folder already saved stays as it was, and the replaced one goes. */
  async replace(path: string, next: string): Promise<void> {
    await this.rewrite((current) =>
      current.some((e) => e.path === next)
        ? current.filter((e) => e.path !== path)
        : current.map((e) => (e.path === path ? { ...e, path: next } : e)),
    );
  }

  async remove(path: string): Promise<void> {
    await this.rewrite((current) => current.filter((e) => e.path !== path));
  }

  /** Lands an imported entry whole — a folder already saved takes the
   * file's workspaces, in its place. */
  async land(entry: SavedRoot): Promise<void> {
    await this.rewrite((current) =>
      current.some((e) => e.path === entry.path)
        ? current.map((e) => (e.path === entry.path ? entry : e))
        : [...current, entry],
    );
  }

  /** Every entry goes — the earlier version's copies with them. */
  async wipe(): Promise<void> {
    await this.kv.update(this.key, undefined);
    await this.kv.update(STORAGE_KEYS.savedRootsBefore090, undefined);
    await this.workspace?.kv.update(STORAGE_KEYS.workspaceSavedRootsBefore090, undefined);
  }

  private async rewrite(transform: (current: SavedRoot[]) => SavedRoot[]): Promise<void> {
    await this.kv.update(this.key, transform(this.list()));
  }
}

/** `entries` with `path` saved for `here` too, or — "auto" — for every
 * workspace; a folder not saved yet joins the end. */
function saved(entries: readonly SavedRoot[], path: string, here: WorkspaceId | "auto"): SavedRoot[] {
  const at = entries.findIndex((e) => e.path === path);
  const was: Reach<WorkspaceId> = at === -1 ? [] : entries[at]!.workspaces;
  const workspaces = here === "auto" ? "auto" : withOne(was, here, true);
  if (at === -1) return [...entries, { path, workspaces }];
  return entries.map((e, i) => (i === at ? { path, workspaces } : e));
}
