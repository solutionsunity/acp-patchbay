// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Who a stored thing reaches, in one grammar for every set it is chosen
// over — the agents an MCP server is given to, the workspaces a server or a
// saved root is on in: every one ("auto", the ones to come included),
// exactly the listed ones, or every one but the listed. An empty list
// reaches none. Read on both sides of the webview boundary: the stores
// decide with it, the scope control edits it.

export type Reach<Id extends string = string> = "auto" | readonly Id[] | { readonly except: readonly Id[] };

/** The ids a reach names — the list, or the ones it leaves out. */
export function namedIn<Id extends string>(reach: Reach<Id>): readonly Id[] {
  if (reach === "auto") return [];
  return isList(reach) ? reach : reach.except;
}

function isList<Id extends string>(reach: Reach<Id>): reach is readonly Id[] {
  return Array.isArray(reach);
}

/** Whether the reach takes `id`. Null is none of the set — a window with no
 * workspace open: no list names it, so only every one, and every one but
 * some, reach it. */
export function reaches<Id extends string>(reach: Reach<Id>, id: Id | null): boolean {
  if (reach === "auto") return true;
  if (isList(reach)) return id !== null && reach.includes(id);
  return id === null || !reach.except.includes(id);
}

/** The reach with `id` switched on or off, every other one as it was: on
 * joins a list or leaves the exceptions, off leaves a list or joins them —
 * and switched off, every one becomes every one but it. */
export function withOne<Id extends string>(reach: Reach<Id>, id: Id, on: boolean): Reach<Id> {
  if (reaches(reach, id) === on) return reach;
  if (reach === "auto") return { except: [id] };
  if (isList(reach)) return on ? [...reach, id] : reach.filter((x) => x !== id);
  return { except: on ? reach.except.filter((x) => x !== id) : [...reach.except, id] };
}

/** The reach with `id` named nowhere — one that is gone (a removed agent)
 * leaves its list and its exceptions; a list it alone was on then reaches
 * none, as chosen. */
export function forget<Id extends string>(reach: Reach<Id>, id: Id): Reach<Id> {
  if (reach === "auto") return reach;
  if (isList(reach)) return reach.filter((x) => x !== id);
  return { except: reach.except.filter((x) => x !== id) };
}

/** A copy the store owns — the view's arrays stay the view's. */
export function ownReach<Id extends string>(reach: Reach<Id>): "auto" | Id[] | { except: Id[] } {
  if (reach === "auto") return "auto";
  return isList(reach) ? [...reach] : { except: [...reach.except] };
}
