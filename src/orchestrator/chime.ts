// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Which surface plays a turn's chime. The orchestrator decides that a chime
// is due; one Agent View surface plays it, on the user's machine, whatever
// machine the extension host runs on. Every agent surface is kept alive
// while hidden, so one behind another sidebar tab, in a collapsed sidebar or
// in a background editor tab can still play. Two facts can leave a surface
// unable to: it is gone (closed, or hidden from its container), or the user
// hasn't touched it since its page loaded — Chromium starts audio only for a
// page the user has interacted with, and a page that loads again starts
// untouched.
//
// No such surface means no chime: no webview exists to play it, and VS Code
// gives an extension no other way to make a sound on the user's machine.
// The attention badge still marks the turn. A deliberate scope decision,
// revisited when VS Code offers one.

export interface SurfaceFacts {
  visible: boolean;
  /** The user has touched it since its page loaded. */
  activated: boolean;
}

/** The one surface to play a chime: a touched one, a visible one first —
 * the user is nearest it — else the first opened. Null when none can. */
export function chimePlayer(surfaces: ReadonlyMap<string, SurfaceFacts>): string | null {
  let player: string | null = null;
  for (const [surface, facts] of surfaces) {
    if (!facts.activated) continue;
    if (facts.visible) return surface;
    player ??= surface;
  }
  return player;
}
