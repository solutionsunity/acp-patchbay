// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The MCP chip's rows as a pure function — the sibling of roots-controls.ts,
// extracted for the same reason: every reachable state of the facts it reads
// is named in a test, never an inline render expression. A session's MCP
// servers ride its open (ACP hands `mcpServers` only on session/new, load
// and resume), so the chip shows what the last open gave, and says what
// the next one changes: a server added for this session alone, or one
// taken back. The chip only adds and saves (the shortcut); Settings
// manages where a server is on.
import type { McpServerListedView, SessionMcpView } from "../../../shared/protocol";
import { EDITOR_SERVER_ID, EDITOR_SERVER_NAME } from "../../../shared/names";
import type { PatchbayMcpServerId } from "../../../shared/ids";
import { reaches } from "../../../shared/reach";
import type { WorkspaceId } from "../../../shared/workspace";
import { whereSaid } from "../../shared/where";

export interface McpChipRow {
  id: PatchbayMcpServerId;
  name: string;
  /** What the row says of it: built in, saved where, or this session's. */
  label: string;
  /** Given to this session alone — the row takes it back. */
  own: boolean;
  /** The next open changes it: "add" — not given yet; "remove" — given
   * now, gone at the next open. */
  next: "add" | "remove" | null;
  /** Saved for this workspace — or offered for saving, where "this
   * workspace" needs an open one. Null for the built-in server. */
  save: { kind: "saved" } | { kind: "unsaved"; workspaceOpen: boolean } | null;
}

export interface McpChipControls {
  rows: McpChipRow[];
  /** Configured servers the session neither has nor adds — the Add menu. */
  addable: McpServerListedView[];
  /** What the next open does, said once — null when nothing waits. */
  note: string | null;
  /** The note offers that open now. */
  reopen: boolean;
}

export function mcpChipControls(facts: {
  mcp: SessionMcpView | undefined;
  servers: readonly McpServerListedView[];
  here: WorkspaceId | null;
  /** The agent can open the session again: it declares session/load or
   * session/resume. */
  canReopen: boolean;
}): McpChipControls {
  const given = facts.mcp?.given ?? [];
  const added = facts.mcp?.added ?? [];
  const byId = new Map(facts.servers.map((s) => [s.id, s]));
  const row = (id: PatchbayMcpServerId, next: McpChipRow["next"]): McpChipRow | null => {
    if (id === EDITOR_SERVER_ID) return { id, name: EDITOR_SERVER_NAME, label: "built-in", own: false, next: null, save: null };
    const server = byId.get(id);
    if (server === undefined) return null; // removed since — gone at the next open
    const onHere = reaches(server.workspaces, facts.here);
    const own = added.includes(id);
    return {
      id,
      name: server.name,
      label: next === "add" ? "this session · at next open" : next === "remove" ? "until next open" : own ? "this session" : `saved · ${whereSaid(server.workspaces, facts.here)}`,
      own,
      next,
      save: onHere ? { kind: "saved" } : { kind: "unsaved", workspaceOpen: facts.here !== null },
    };
  };
  const rows = [
    // Given now: one neither its own nor on here was its own, taken back.
    ...given.map((id) => {
      const server = byId.get(id);
      const takenBack = id !== EDITOR_SERVER_ID && server !== undefined && !added.includes(id) && !reaches(server.workspaces, facts.here);
      return row(id, takenBack ? "remove" : null);
    }),
    ...added.filter((id) => !given.includes(id)).map((id) => row(id, "add")),
  ].filter((r): r is McpChipRow => r !== null);
  const waiting = facts.mcp !== undefined && rows.some((r) => r.next !== null);
  return {
    rows,
    addable: facts.servers.filter((s) => !given.includes(s.id) && !added.includes(s.id)),
    note: !waiting
      ? null
      : facts.canReopen
        ? "the agent gets MCP servers when the session opens — the change waits for its next open"
        : "the agent gets MCP servers when the session opens, and can't reopen this one — a new session gets them",
    reopen: waiting && facts.canReopen,
  };
}
