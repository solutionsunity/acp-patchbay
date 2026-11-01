// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Where a server or a saved root is on, said from this window: the one
// phrasing every surface that names it reads — the roots chip, the MCP
// chip, the Settings cards.
import { count } from "../../shared/count";
import { namedIn, type Reach } from "../../shared/reach";
import type { WorkspaceId } from "../../shared/workspace";

export function whereSaid(reach: Reach<WorkspaceId>, here: WorkspaceId | null): string {
  if (reach === "auto") return "every workspace";
  const named = namedIn(reach);
  const others = named.filter((id) => id !== here).length;
  const withHere = here !== null && named.includes(here);
  if (Array.isArray(reach)) {
    if (named.length === 0) return "no workspace";
    if (!withHere) return count(others, "other workspace");
    return others === 0 ? "this workspace" : `this and ${count(others, "other workspace")}`;
  }
  if (named.length === 0) return "every workspace";
  if (!withHere) return `every workspace but ${count(others, "other")}`;
  return others === 0 ? "every workspace but this one" : `every workspace but this and ${count(others, "other")}`;
}
