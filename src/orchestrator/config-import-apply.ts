// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Landing an import: each item the user ticked landed by its owner, on
// the id the plan matched it to. A taken item replaces what is here whole —
// its env values, key and composer choices with it — keeping only what this
// machine knows of it on its own, which its owner decides. Nothing the file
// doesn't name is touched. An item that fails is said, and the rest land.
import { writeLocationLabel, type KnobSeed, type PreferencesView, type WriteEntry } from "../shared/protocol";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../shared/ids";
import type { ConfigurationRead } from "./config-import";
import { ruleLabel } from "../shared/command-rules";
import { commandRuleItemId, routingOn, writeLocationItemId, type ImportPlan } from "./config-import-plan";
import type { AgentConfig } from "./stores/agent-configs";
import type { McpServerConfig } from "./stores/mcp-server-configs";
import { type CommandRule, withRule } from "./stores/permission-rules";
import { withWriteEntry } from "./stores/write-scope";
import { agentErrorText } from "./readers/agent-error";

type Env = Record<string, string>;

/** Who an import lands each item through: an agent and a server by their
 * owners — which keep what this machine knows of each — and each setting
 * by the store that holds it. */
export interface ImportTargets {
  agents: {
    landImported(record: AgentConfig, env: Env, knobs: KnobSeed | undefined): Promise<string>;
    /** Re-resolves a downloaded agent's launch for this machine; false when
     * the registry serves nothing it runs. */
    resolveHere(id: PatchbayAgentId): Promise<boolean>;
  };
  mcpServers: { landImported(record: McpServerConfig, secret: { env?: Env; key?: string } | undefined): Promise<string> };
  preferences: { set(patch: Partial<PreferencesView>): Promise<unknown> };
  machineRules: { get(): { commandRules: CommandRule[] }; set(rules: CommandRule[]): Promise<void> };
  machineWriteScope: { get(): WriteEntry[]; set(entries: readonly WriteEntry[]): Promise<void> };
  machineSavedRoots: { add(path: string): Promise<void> };
}

export interface ImportOutcome {
  landed: number;
  failures: string[];
}

export async function applyImport(
  read: ConfigurationRead,
  plan: ImportPlan,
  take: ReadonlySet<string>,
  targets: ImportTargets,
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { landed: 0, failures: [] };
  const taken = (id: string) => take.has(id) && plan.items.some((i) => i.id === id && i.fate !== "unchanged");
  const land = async (label: string, write: () => Promise<string | void>) => {
    try {
      // A write may land with a word to say about it.
      const note = await write();
      outcome.landed++;
      if (typeof note === "string") outcome.failures.push(`${label}: ${note}`);
    } catch (err) {
      outcome.failures.push(`${label}: ${agentErrorText(err)}`);
    }
  };

  for (const agent of read.agents) {
    if (!taken(`agent:${agent.id}`)) continue;
    const id = (plan.agentIds.get(agent.id) ?? agent.id) as PatchbayAgentId;
    await land(agent.name, async () => {
      const named = await targets.agents.landImported({ ...agent, id }, read.secrets.agents[agent.id] ?? {}, read.knobs[agent.id]);
      if (agent.link?.distributionKind === "binary" && !(await targets.agents.resolveHere(id))) {
        return "the registry has no download of it for this machine — it stays as the file had it";
      }
      if (named !== agent.name) return `added as "${named}" — the name was taken here`;
    });
  }

  for (const server of read.mcpServers) {
    if (!taken(`mcpServer:${server.id}`)) continue;
    const id = (plan.serverIds.get(server.id) ?? server.id) as PatchbayMcpServerId;
    await land(server.name, async () => {
      const record: McpServerConfig = { ...server, id, routing: routingOn(server.routing, plan.agentIds) };
      const named = await targets.mcpServers.landImported(record, read.secrets.mcpServers[server.id]);
      if (named !== record.name) return `added as "${named}" — the name was taken here`;
    });
  }

  if (taken("preferences")) await land("Preferences", () => targets.preferences.set(read.preferences).then(() => {}));

  for (const rule of read.machineCommandRules) {
    if (!taken(commandRuleItemId(rule))) continue;
    await land(ruleLabel(rule), () => targets.machineRules.set(withRule(targets.machineRules.get().commandRules, rule)));
  }

  for (const { location, on } of read.machineWriteScope) {
    if (!taken(writeLocationItemId(location))) continue;
    await land(writeLocationLabel(location), () =>
      targets.machineWriteScope.set(withWriteEntry(targets.machineWriteScope.get(), location, on)),
    );
  }

  for (const root of read.machineSavedRoots) {
    if (taken(`savedRoot:${root}`)) await land(root, () => targets.machineSavedRoots.add(root));
  }
  return outcome;
}
