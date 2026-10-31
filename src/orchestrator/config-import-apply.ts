// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Landing an import: each item the user ticked written through its store,
// on the id the plan matched it to. A taken item replaces what is here
// whole — its env values, key and composer choices with it — keeping only
// what this machine knows of it on its own: the version an agent last
// answered with, and an OAuth sign-in to the same server. A downloaded
// agent's way back stays behind with the build it names. Nothing the file
// doesn't name is touched. An item that fails is said, and the rest land.
import { isDeepStrictEqual } from "node:util";
import { writeLocationLabel, type KnobSeed, type PreferencesView, type WriteEntry } from "../shared/protocol";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../shared/ids";
import type { ConfigurationRead } from "./config-import";
import { ruleLabel } from "../shared/command-rules";
import { commandRuleItemId, routingOn, writeLocationItemId, type ImportPlan } from "./config-import-plan";
import type { AgentConfig } from "./stores/agent-configs";
import { authTypeOf, type McpServerConfig } from "./stores/mcp-server-configs";
import type { StoredToken } from "./stores/mcp-server-tokens";
import { type CommandRule, withRule } from "./stores/permission-rules";
import { withWriteEntry } from "./stores/write-scope";

type Env = Record<string, string>;

interface Records<T> {
  get(id: string): T | undefined;
  add(value: T): Promise<string>;
  upsert(value: T): Promise<void>;
}

/** The stores an import writes, and the one act it asks of the agents. */
export interface ImportTargets {
  agentConfigs: Records<AgentConfig>;
  agentEnv: { set(id: string, env: Env): Promise<void> };
  composerKnobs: { record(id: PatchbayAgentId, seed: KnobSeed): Promise<void>; remove(id: PatchbayAgentId): Promise<void> };
  mcpServerConfigs: Records<McpServerConfig>;
  mcpServerEnv: { set(id: string, env: Env): Promise<void> };
  mcpServerTokens: {
    set(id: PatchbayMcpServerId, token: StoredToken): Promise<void>;
    remove(id: PatchbayMcpServerId): Promise<void>;
  };
  preferences: { set(patch: Partial<PreferencesView>): Promise<unknown> };
  machineRules: { get(): { commandRules: CommandRule[] }; set(rules: CommandRule[]): Promise<void> };
  machineWriteScope: { get(): WriteEntry[]; set(entries: readonly WriteEntry[]): Promise<void> };
  machineSavedRoots: { add(path: string): Promise<void> };
  /** Re-resolves a downloaded agent's launch for this machine; false when
   * the registry serves nothing it runs. */
  resolveHere(id: PatchbayAgentId): Promise<boolean>;
}

export interface ImportOutcome {
  landed: number;
  failures: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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
      outcome.failures.push(`${label}: ${message(err)}`);
    }
  };

  for (const agent of read.agents) {
    if (!taken(`agent:${agent.id}`)) continue;
    const id = (plan.agentIds.get(agent.id) ?? agent.id) as PatchbayAgentId;
    await land(agent.name, async () => {
      const mine = targets.agentConfigs.get(id);
      // A binary way back is the exporting machine's build: it stays there.
      const previous = agent.previous?.distributionKind === "binary" ? null : agent.previous;
      const record: AgentConfig = { ...agent, id, previous, lastSeenVersion: mine?.lastSeenVersion ?? null };
      let named = record.name;
      if (mine === undefined) named = await targets.agentConfigs.add(record);
      else await targets.agentConfigs.upsert(record);
      await targets.agentEnv.set(id, read.secrets.agents[agent.id] ?? {});
      const knobs = read.knobs[agent.id];
      if (knobs === undefined) await targets.composerKnobs.remove(id);
      else await targets.composerKnobs.record(id, knobs);
      if (agent.link?.distributionKind === "binary" && !(await targets.resolveHere(id))) {
        return "the registry has no download of it for this machine — it stays as the file had it";
      }
      if (named !== record.name) return `added as "${named}" — the name was taken here`;
    });
  }

  for (const server of read.mcpServers) {
    if (!taken(`mcpServer:${server.id}`)) continue;
    const id = (plan.serverIds.get(server.id) ?? server.id) as PatchbayMcpServerId;
    await land(server.name, async () => {
      const mine = targets.mcpServerConfigs.get(id);
      const record: McpServerConfig = { ...server, id, routing: routingOn(server.routing, plan.agentIds) };
      let named = record.name;
      if (mine === undefined) named = await targets.mcpServerConfigs.add(record);
      else await targets.mcpServerConfigs.upsert(record);
      const secret = read.secrets.mcpServers[server.id];
      await targets.mcpServerEnv.set(id, secret?.env ?? {});
      const auth = authTypeOf(server.source);
      // A sign-in is this machine's own: it stays with a server whose
      // connection is unchanged, and goes with one that moved.
      const keepsSignIn = auth === "oauth" && mine !== undefined && isDeepStrictEqual(mine.source, server.source);
      if (auth === "header" && secret?.key !== undefined) await targets.mcpServerTokens.set(id, { accessToken: secret.key });
      else if (!keepsSignIn) await targets.mcpServerTokens.remove(id);
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
