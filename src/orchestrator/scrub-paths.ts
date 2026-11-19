// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Text that is about to leave the machine, with the places it names made
// anonymous. A path holds the user's name, and often a client's or a
// project's. The folders this window knows — the workspace's, the temp
// folder, the home folder — are replaced exactly, longest first, however
// the text spells them; then the shapes a home folder takes anywhere are,
// for a path on a machine or an account this window knows nothing of.

/** The folders known exactly, each with what stands in for it. */
export interface KnownFolders {
  workspace: readonly string[];
  temp: string;
  home: string;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every way a text spells one folder: as it is, with the other slash, as
 * a JSON string holds its backslashes, and as a link encodes it. */
function spellings(folder: string): string[] {
  const forward = folder.replaceAll("\\", "/");
  const backward = folder.replaceAll("/", "\\");
  return [...new Set([folder, forward, backward, backward.replaceAll("\\", "\\\\"), encodeURI(forward)])].filter((s) => s.length > 1);
}

/** A home folder as any machine names one: its user's name is what goes.
 * A Windows account's name may hold spaces, so there the name runs to the
 * next separator — and to the end of the line where none follows: too much
 * taken is the safe way to be wrong. */
const HOME_SHAPES: readonly [RegExp, string][] = [
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/"'<>|:\r\n]+/g, "$1<user>"],
  [/(\/mnt\/[a-z]\/Users\/)[^/"'<>|:\r\n]+/g, "$1<user>"],
  [/(\/(?:home|Users)\/)[^/\s"'<>|:]+/g, "$1<user>"],
];

export function scrubPaths(text: string, known: KnownFolders): string {
  const named: [string, string][] = [
    ...known.workspace.map((folder): [string, string] => [folder, "<workspace>"]),
    [known.temp, "<tmp>"],
    [known.home, "~"],
  ];
  const exact = named
    .filter(([folder]) => folder.length > 1)
    .flatMap(([folder, standIn]) => spellings(folder).map((spelling): [string, string] => [spelling, standIn]))
    .sort((a, b) => b[0].length - a[0].length);
  let out = text;
  // A drive's letter and a folder's case are not told apart on Windows,
  // and a text may spell either way: matched without regard to case.
  for (const [spelling, standIn] of exact) out = out.replace(new RegExp(escaped(spelling), "gi"), standIn);
  for (const [shape, standIn] of HOME_SHAPES) out = out.replace(shape, standIn);
  return out;
}
