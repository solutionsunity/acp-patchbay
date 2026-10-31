// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// The moments the ACP registry is read at — the one list. The registry
// store reads at them, its network class taken from here, and Preferences
// › Network tells the user when the registry is read, from here too: a
// moment added here is read, logged and said, with nothing else to touch.
import type { PreferencesView } from "./protocol";

/** Each moment as a person reads it. One that exists only for update
 * notices names the preference that switches it; every other is the
 * user's own act, never switched. */
export const REGISTRY_READS = {
  startup: { said: "the window starts", switch: "checkAgentUpdates" },
  "new-session": { said: "a new session starts", switch: "checkAgentUpdates" },
  settings: { said: "Settings opens", switch: "checkAgentUpdates" },
  browse: { said: "opening the registry search" },
  manual: { said: "Refresh registry" },
  add: { said: "an Add" },
  upgrade: { said: "an Upgrade" },
  reset: { said: "a Reset to the registry" },
  import: { said: "an import" },
  download: { said: "downloading an agent" },
} as const satisfies Record<string, { said: string; switch?: keyof PreferencesView }>;

export type RegistryReadMoment = keyof typeof REGISTRY_READS;

/** A preference that switches registry reads. */
type ReadSwitch = Extract<(typeof REGISTRY_READS)[RegistryReadMoment], { switch: unknown }>["switch"];

/** What the moments say, as lists ("a, b, and c"): those `key` switches,
 * and those the user's own act makes. */
export function registryReadsSaid(key: ReadSwitch): { switched: string; acted: string } {
  const reads = Object.values(REGISTRY_READS);
  const said = (list: readonly { said: string }[]) =>
    new Intl.ListFormat("en", { type: "conjunction" }).format(list.map((r) => r.said));
  return {
    switched: said(reads.filter((r) => "switch" in r && r.switch === key)),
    acted: said(reads.filter((r) => !("switch" in r))),
  };
}
