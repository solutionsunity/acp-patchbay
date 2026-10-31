// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// "Update available" — one fact, computed here and published to every
// surface that offers an upgrade (the Settings card, the Agent View's agent
// chip, the startup notice), so no surface re-derives it from its own copy
// of the registry and the configs.
import type { AgentUpdate } from "../shared/protocol";
import type { PatchbayAgentId } from "../shared/ids";

interface ConfigFacts {
  id: PatchbayAgentId;
  origin: string | null;
  link: { pinnedVersion: string } | null;
}

/** Registry version vs. what each config is pinned to — an entry only where
 * there is something newer. Linked through the config's own origin — never
 * the config id, which may predate the registry naming. The version the
 * agent reports is a different naming scheme and is never compared: only
 * the pin is in the registry's. Custom and edited commands have no pin to
 * compare. */
export function agentUpdates(
  registry: readonly { id: string; version: string }[],
  configs: readonly ConfigFacts[],
): ReadonlyMap<PatchbayAgentId, AgentUpdate> {
  const updates = new Map<PatchbayAgentId, AgentUpdate>();
  for (const { id, origin, link } of configs) {
    if (origin === null || link === null) continue;
    const latest = registry.find((r) => r.id === origin)?.version;
    if (latest === undefined || latest === link.pinnedVersion) continue;
    updates.set(id, { from: link.pinnedVersion, to: latest });
  }
  return updates;
}
