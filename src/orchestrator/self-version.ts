// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What Patchbay says about its own version — decided here from what is
// read, never from the network: the version running, the newest version a
// window on this machine has run, whether any agent is configured, and the
// extensions folder this copy runs from. The editor gives a running
// extension no signal that a newer copy was installed beside it, so the
// folder is read as the editor lays it out: each copy in `<id>-<version>`
// (a platform build adds `-<target>`), and the copies it will remove at its
// next start listed `true` in `.obsolete`. An update marks the running
// copy there; an uninstall or a downgrade leaves no newer copy beside it.
// `.obsolete` keeps names long after their folders are gone, and another
// extension's id can start with this one's, so a folder counts only by its
// exact shape. A layout read any other way is no moment.
import { isNewer } from "../shared/product";

export type SelfVersionMoment =
  /** Nothing on this machine has run Patchbay, and no agent exists. */
  | { kind: "installed"; version: string }
  /** A newer version than this machine last ran — or a first record where
   * agents already exist: a version before this one ran without keeping it. */
  | { kind: "updated"; version: string }
  /** A newer copy is installed beside this one; it runs once the window
   * reloads. */
  | { kind: "waiting"; version: string };

export interface SelfVersionFacts {
  /** `publisher.name`, any casing. */
  id: string;
  /** The version this copy runs. */
  running: string;
  /** The newest version recorded as run on this machine, as stored. */
  seen: unknown;
  hasAgents: boolean;
  /** The extensions folder: this copy's own folder name, `.obsolete` as
   * parsed, and every name beside it — null when it couldn't be read. */
  disk: { folder: string; obsolete: unknown; names: readonly string[] } | null;
}

/** The version a folder of this extension holds, else null. */
function folderVersion(id: string, name: string): string | null {
  const prefix = `${id.toLowerCase()}-`;
  if (!name.toLowerCase().startsWith(prefix)) return null;
  const m = /^(\d+\.\d+\.\d+)(?:-[a-z0-9]+-[a-z0-9]+)?$/.exec(name.slice(prefix.length));
  return m === null ? null : m[1]!;
}

/** The moments due now, in the order they are said. Every moment is
 * decided afresh from the facts; saying each once is the caller's. */
export function selfVersionMoments(facts: SelfVersionFacts): SelfVersionMoment[] {
  const moments: SelfVersionMoment[] = [];
  if (typeof facts.seen !== "string") moments.push({ kind: facts.hasAgents ? "updated" : "installed", version: facts.running });
  else if (isNewer(facts.running, facts.seen)) moments.push({ kind: "updated", version: facts.running });
  const waiting = waitingVersion(facts);
  if (waiting !== null) moments.push({ kind: "waiting", version: waiting });
  return moments;
}

/** The newest copy installed beside this one while this one is marked for
 * removal — null unless the folder reads exactly so. */
function waitingVersion({ id, running, disk }: SelfVersionFacts): string | null {
  if (disk === null || typeof disk.obsolete !== "object" || disk.obsolete === null) return null;
  const obsolete = disk.obsolete as Record<string, unknown>;
  if (obsolete[disk.folder] !== true || folderVersion(id, disk.folder) === null) return null;
  let best: string | null = null;
  for (const name of disk.names) {
    const version = obsolete[name] === true ? null : folderVersion(id, name);
    if (version !== null && isNewer(version, best ?? running)) best = version;
  }
  return best;
}
