// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The files a session was given — dropped on the composer, pasted or
// picked as images — kept on patchbay's own disk for as long as the
// session lives. Its chips name them until they are sent, and the agent's
// history links them after: a dropped file always, an image for an agent
// that takes none inline — a link the agent may follow in any later turn.
// One folder per session, under its agent and its workspace. It leaves
// with the session — deleted, gone from its agent's list, its agent
// removed — stays through a close, and moves with it when a
// never-prompted session is minted again. What the transcript previews stays in the temp stash: a
// preview is ephemeral, a file the agent was handed is not.
//
// A folder's name is a short hash of an id, never the id: the agent mints
// its session ids, and no id may steer a path — or lengthen one past what
// a Windows path holds.
import { createHash } from "node:crypto";
import { renameSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import type { PersistedChip } from "../../shared/protocol";
import type { PatchbayAgentId } from "../../shared/ids";
import type { SessionContinuityStore } from "./session-continuity";

/** A path segment for any string: hex, fixed and short — nothing in it
 * reads as a step (`..`, a separator). */
const segment = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

export class SessionFilesStore {
  constructor(private readonly root: string) {}

  /** The session's folder. */
  dirOf(patchbayAgentId: PatchbayAgentId, sessionId: string, cwd: string): string {
    return join(this.workspaceDir(patchbayAgentId, cwd), segment(sessionId));
  }

  /** Writes a file into the session's folder; returns its path. */
  async put(patchbayAgentId: PatchbayAgentId, sessionId: string, cwd: string, fileName: string, base64: string): Promise<string> {
    const dir = this.dirOf(patchbayAgentId, sessionId, cwd);
    await mkdir(dir, { recursive: true });
    const path = join(dir, fileName);
    await writeFile(path, Buffer.from(base64, "base64"));
    return path;
  }

  /** The session left: its files go. */
  forget(patchbayAgentId: PatchbayAgentId, sessionId: string, cwd: string): Promise<void> {
    return rm(this.dirOf(patchbayAgentId, sessionId, cwd), { recursive: true, force: true });
  }

  /** The agent is gone: every session's files, every workspace. */
  forgetAgent(patchbayAgentId: PatchbayAgentId): Promise<void> {
    return rm(join(this.root, segment(patchbayAgentId)), { recursive: true, force: true });
  }

  /** The agent's sessions of one workspace against what still names them:
   * the folder of a session not `kept` leaves. Other workspaces' folders
   * are not this walk's to judge. */
  async reconcile(patchbayAgentId: PatchbayAgentId, cwd: string, kept: ReadonlySet<string>): Promise<void> {
    const dir = this.workspaceDir(patchbayAgentId, cwd);
    const keep = new Set([...kept].map(segment));
    const names = await readdir(dir).catch(() => []);
    await Promise.all(names.filter((name) => !keep.has(name)).map((name) => rm(join(dir, name), { recursive: true, force: true })));
  }

  /** A never-prompted session minted again: its folder follows it to the
   * agent's new id for it — synchronously, so it moves together with the
   * session's row and no stage lands in between. True when a folder moved;
   * false when there was none, or it couldn't move — its files then stay
   * where their chips already name them. */
  move(patchbayAgentId: PatchbayAgentId, from: string, to: string, cwd: string): boolean {
    try {
      renameSync(this.dirOf(patchbayAgentId, from, cwd), this.dirOf(patchbayAgentId, to, cwd));
      return true;
    } catch {
      return false;
    }
  }

  /** A file that lived elsewhere joins the session's folder under its own
   * name — copied, since the two may sit on different disks, then removed
   * where it was. Null when it is already gone. */
  async adopt(patchbayAgentId: PatchbayAgentId, sessionId: string, cwd: string, source: string): Promise<string | null> {
    const dir = this.dirOf(patchbayAgentId, sessionId, cwd);
    await mkdir(dir, { recursive: true });
    const path = join(dir, basename(source));
    try {
      await copyFile(source, path);
    } catch {
      return null;
    }
    await rm(source, { force: true });
    return path;
  }

  /** "Disconnect & erase all data". */
  wipe(): Promise<void> {
    return rm(this.root, { recursive: true, force: true });
  }

  private workspaceDir(patchbayAgentId: PatchbayAgentId, cwd: string): string {
    return join(this.root, segment(patchbayAgentId), segment(cwd));
  }
}

/** Once, before any session reads its chips: a chip staged before sessions
 * kept their own files names its file in the temp stash. Each such file
 * joins its session's folder and the chip names it there; one already gone
 * drops its chip. No chip names the stash afterwards, so this never runs
 * twice — except for a row with no workspace on record, which waits for
 * the walk that stamps it. */
export async function adoptStashedChips(continuity: SessionContinuityStore, files: SessionFilesStore, stash: string): Promise<void> {
  const stashed = (c: PersistedChip): c is Extract<PersistedChip, { path: string }> =>
    (c.kind === "image" || c.kind === "attachment") && c.path.startsWith(stash + sep);
  for (const row of continuity.list()) {
    if (row.cwd === undefined || !(row.chips ?? []).some(stashed)) continue;
    const chips: PersistedChip[] = [];
    for (const chip of row.chips ?? []) {
      if (!stashed(chip)) {
        chips.push(chip);
        continue;
      }
      const path = await files.adopt(row.patchbayAgentId, row.sessionId, row.cwd, chip.path);
      if (path !== null) chips.push({ ...chip, path });
    }
    await continuity.patch(row.patchbayAgentId, row.sessionId, row.cwd, { chips });
  }
}
