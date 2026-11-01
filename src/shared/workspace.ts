// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// A workspace as patchbay names it: the URI VS Code opened — the
// `.code-workspace` file of a multi-root workspace, else its folder — in
// its full string form, the remote host included (`vscode-remote://
// ssh-remote%2Bbox/srv/app`). A storage key: the scopes of MCP servers and
// saved roots name workspaces by it, so its format is fixed here once. An
// untitled multi-root workspace's URI changes when it is saved, and what
// was scoped to it doesn't follow.
declare const brand: unique symbol;
export type WorkspaceId = string & { readonly [brand]: "workspace" };

/** A workspace as a person reads it: the folder or workspace file's path,
 * and the remote host it lives on ("" on this machine). */
export function workspaceLabel(id: WorkspaceId): { path: string; host: string } {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return { path: id, host: "" };
  }
  if (url.protocol === "untitled:") return { path: "untitled workspace", host: "" };
  // A drive letter rides the path as "/c:/…" — read as Windows writes it.
  const decoded = decodeURIComponent(url.pathname);
  const path = /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
  return { path, host: url.protocol === "file:" ? decodeURIComponent(url.host) : decodeURIComponent(url.host || url.protocol.slice(0, -1)) };
}
