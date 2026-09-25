// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// "Update available" — one fact, computed here and published to every
// surface that offers an upgrade (the Settings card, the Agent View's agent
// chip, the startup notice), so no surface re-derives it from its own copy
// of the registry and the configs.
import type { AgentUpdate } from "../shared/protocol";

interface ConfigFacts {
  id: string;
  registrySource: { registryId: string; pinnedVersion: string } | null;
  lastSeenVersion: string | null;
}

/** Registry version vs. what each config is pinned to — an entry only where
 * there is something newer. Linked through the config's own
 * registrySource.registryId — never the config id, which may predate the
 * registry naming. Custom commands have nothing to compare. */
export function agentUpdates(
  registry: readonly { id: string; version: string }[],
  configs: readonly ConfigFacts[],
): Readonly<Record<string, AgentUpdate>> {
  const updates: Record<string, AgentUpdate> = {};
  for (const config of configs) {
    const source = config.registrySource;
    if (source === null) continue;
    const latest = registry.find((r) => r.id === source.registryId)?.version;
    if (latest === undefined || latest === source.pinnedVersion) continue;
    // The wire's own fact outranks the pinned ask: a connection that already
    // reported the registry's latest (a launcher serving a newer build than
    // the pin) has no upgrade to offer — offering one would let the pin lie
    // about reality.
    if (config.lastSeenVersion === latest) continue;
    updates[config.id] = { from: source.pinnedVersion, to: latest };
  }
  return updates;
}
