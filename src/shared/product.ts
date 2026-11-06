// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// How patchbay names itself to every peer it speaks to: the agents it
// initializes, the MCP servers it checks, the agents reading its own server,
// the OAuth servers it registers with. One name and one version, the
// extension's own, folded in from its manifest at build. Everything that
// names itself ships inside the extension, so no part keeps a version of
// its own — and every part that weighs one version against another, its own
// or an agent's, orders them here.
import { name, version } from "../../package.json";

export const PRODUCT = { name, version } as const;

/** Whether version `a` is later than `b`, by their numbered parts; one
 * that doesn't read as a version is never later. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const pa = parse(a);
  const pb = parse(b);
  if (pa === undefined || pb === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! > pb[i]!;
  }
  return false;
}
