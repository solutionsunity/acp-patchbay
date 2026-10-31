// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// An import's plan: what a configuration file holds, set against what this
// machine holds — each item new here, the same as here, or different, and
// what the user should know before it lands (an item the same as here
// lands nothing, so it carries nothing to know). An item is matched by its id,
// then by its name: ids are minted per machine, so the same agent added on
// two machines has two, and its name is how its owner tells it apart. A
// matched item lands on this machine's id, keeping what this machine knows
// of it. Nothing here is ever removed by an import, so the plan holds only
// what the file brings.
import { isDeepStrictEqual } from "node:util";
import {
  sameWriteLocation,
  writeLocationKey,
  writeLocationLabel,
  type ImportItemFate,
  type ImportItemView,
  type KnobSeed,
  type PreferencesView,
  type WriteEntry,
  type WriteLocation,
} from "../shared/protocol";
import type { ConfigurationRead } from "./config-import";
import type { AgentConfig } from "./stores/agent-configs";
import { authTypeOf, type McpServerConfig } from "./stores/mcp-server-configs";
import { ruleLabel } from "../shared/command-rules";
import { type CommandRule, sameRule } from "./stores/permission-rules";
import { writeScopeRows } from "./stores/write-scope";

type Env = Record<string, string>;

export interface ImportPlan {
  items: readonly ImportItemView[];
  /** The id each of the file's agents lands on: this machine's when
   * matched, its own when new. */
  agentIds: ReadonlyMap<string, string>;
  serverIds: ReadonlyMap<string, string>;
}

/** What this machine holds, read fresh for the plan. */
export interface LocalConfiguration {
  agents: readonly AgentConfig[];
  agentEnv: Readonly<Record<string, Env>>;
  knobs: Readonly<Record<string, KnobSeed>>;
  mcpServers: readonly McpServerConfig[];
  serverSecrets: Readonly<Record<string, { env: Env; key?: string }>>;
  preferences: PreferencesView;
  machineCommandRules: readonly CommandRule[];
  machineWriteScope: readonly WriteEntry[];
  machineSavedRoots: readonly string[];
}

/** Where this machine's side of a plan is read from. */
export interface LocalSources {
  agentConfigs: { list(): readonly AgentConfig[] };
  agentEnv: { get(id: string): Promise<Env> };
  composerKnobs: { all(): Readonly<Record<string, KnobSeed>> };
  mcpServerConfigs: { list(): readonly McpServerConfig[] };
  mcpServerEnv: { get(id: string): Promise<Env> };
  /** A header server's key; an OAuth sign-in is never compared. */
  headerKey(id: string): Promise<string | undefined>;
  preferences: { get(): PreferencesView };
  machineRules: { get(): { commandRules: CommandRule[] } };
  machineWriteScope: { get(): WriteEntry[] };
  machineSavedRoots: { list(): string[] };
}

/** This machine's side of a plan, read fresh. */
export async function localConfiguration(sources: LocalSources): Promise<LocalConfiguration> {
  const agents = sources.agentConfigs.list();
  const servers = sources.mcpServerConfigs.list();
  const agentEnv: Record<string, Env> = {};
  for (const agent of agents) agentEnv[agent.id] = await sources.agentEnv.get(agent.id);
  const serverSecrets: Record<string, { env: Env; key?: string }> = {};
  for (const server of servers) {
    const key = await sources.headerKey(server.id);
    serverSecrets[server.id] = { env: await sources.mcpServerEnv.get(server.id), ...(key !== undefined ? { key } : {}) };
  }
  return {
    agents,
    agentEnv,
    knobs: sources.composerKnobs.all(),
    mcpServers: servers,
    serverSecrets,
    preferences: sources.preferences.get(),
    machineCommandRules: sources.machineRules.get().commandRules,
    machineWriteScope: sources.machineWriteScope.get(),
    machineSavedRoots: sources.machineSavedRoots.list(),
  };
}

/** Facts of this machine an item's flags read. */
export interface PlanChecks {
  /** Whether a command a launch would run is found here. */
  commandFound(command: string): boolean;
  pathExists(path: string): boolean;
}

/** Matches each incoming record to a local one, by id then by name; a
 * local record is matched once. */
function matchById<T extends { id: string; name: string }>(incoming: readonly T[], local: readonly T[]): Map<string, T> {
  const matched = new Map<string, T>();
  const taken = new Set<string>();
  for (const item of incoming) {
    const byId = local.find((l) => l.id === item.id);
    if (byId !== undefined) {
      matched.set(item.id, byId);
      taken.add(byId.id);
    }
  }
  for (const item of incoming) {
    if (matched.has(item.id)) continue;
    const byName = local.find((l) => l.name === item.name && !taken.has(l.id));
    if (byName !== undefined) {
      matched.set(item.id, byName);
      taken.add(byName.id);
    }
  }
  return matched;
}

/** The fields of two shapes that differ, by label. */
function differing<T extends Record<string, unknown>>(a: T, b: T, labels: Readonly<Record<keyof T, string>>): string[] {
  return (Object.keys(labels) as (keyof T)[]).filter((k) => !isDeepStrictEqual(a[k], b[k])).map((k) => labels[k]);
}

const fateOf = (local: unknown, differs: readonly string[]): ImportItemFate =>
  local === undefined ? "new" : differs.length === 0 ? "unchanged" : "differs";

/** An agent as it would run on any machine: a downloaded binary's command
 * is a path into the machine's own cache, and its archive that machine's
 * build — neither travels, so neither is compared. Its way back is the undo
 * of an upgrade, not configuration: never a difference either. */
function portableAgent(agent: AgentConfig, env: Env, knobs: KnobSeed | undefined) {
  const { link } = agent;
  return {
    name: agent.name,
    command: link?.distributionKind === "binary" ? null : agent.command,
    args: agent.args,
    autoConnect: agent.autoConnect,
    defaults: agent.defaults,
    origin: agent.origin,
    link: link === null ? null : { distributionKind: link.distributionKind, pinnedVersion: link.pinnedVersion },
    env,
    knobs: knobs ?? null,
  };
}

const AGENT_LABELS = {
  name: "name",
  command: "command",
  args: "arguments",
  autoConnect: "connect on window open",
  defaults: "defaults",
  origin: "registry entry",
  link: "registry version",
  env: "env values",
  knobs: "composer choices",
} as const;

const SERVER_LABELS = {
  name: "name",
  source: "connection",
  routing: "which agents get it",
  active: "on or off",
  transport: "transport",
  env: "env values",
  key: "API key",
} as const;

/** A server's routing names agents by id: the file's ids become the ids
 * those agents land on here. */
export function routingOn(routing: McpServerConfig["routing"], agentIds: ReadonlyMap<string, string>): McpServerConfig["routing"] {
  const on = (ids: readonly string[]) => ids.map((id) => agentIds.get(id) ?? id);
  if (routing === "auto") return routing;
  if (Array.isArray(routing)) return on(routing);
  return { except: on(routing.except) };
}

export const writeLocationItemId = (location: WriteLocation) => `writeLocation:${writeLocationKey(location)}`;
export const commandRuleItemId = (rule: CommandRule) => `commandRule:${rule.kind}:${rule.pattern}`;

export function planImport(read: ConfigurationRead, local: LocalConfiguration, checks: PlanChecks): ImportPlan {
  const items: ImportItemView[] = [];

  const agentMatch = matchById(read.agents, local.agents);
  const agentIds = new Map(read.agents.map((a) => [a.id, agentMatch.get(a.id)?.id ?? a.id]));
  for (const agent of read.agents) {
    const mine = agentMatch.get(agent.id);
    const theirs = portableAgent(agent, read.secrets.agents[agent.id] ?? {}, read.knobs[agent.id]);
    const differs =
      mine === undefined
        ? []
        : differing(portableAgent(mine, local.agentEnv[mine.id] ?? {}, local.knobs[mine.id]), theirs, AGENT_LABELS);
    const fate = fateOf(mine, differs);
    const flags: string[] = [];
    if (fate !== "unchanged") {
      if (agent.link?.distributionKind === "binary") flags.push("downloaded again for this machine at its first connect");
      else if (agent.link === null && !checks.commandFound(agent.command)) flags.push(`${agent.command} isn't found on this machine`);
    }
    items.push({ id: `agent:${agent.id}`, part: "agents", kind: "agent", label: agent.name, fate, differs, flags });
  }

  const serverMatch = matchById(read.mcpServers, local.mcpServers);
  const serverIds = new Map(read.mcpServers.map((s) => [s.id, serverMatch.get(s.id)?.id ?? s.id]));
  for (const server of read.mcpServers) {
    const mine = serverMatch.get(server.id);
    const secret = read.secrets.mcpServers[server.id];
    const portable = (s: McpServerConfig, routing: McpServerConfig["routing"], held: { env: Env; key?: string } | undefined) => ({
      name: s.name,
      source: s.source,
      routing,
      active: s.active,
      transport: s.transport,
      env: held?.env ?? {},
      key: held?.key ?? null,
    });
    const theirs = portable(server, routingOn(server.routing, agentIds), secret);
    const differs = mine === undefined ? [] : differing(portable(mine, mine.routing, local.serverSecrets[mine.id]), theirs, SERVER_LABELS);
    const fate = fateOf(mine, differs);
    const flags: string[] = [];
    if (fate !== "unchanged") {
      if (authTypeOf(server.source) === "oauth") flags.push("needs a fresh sign-in on this machine");
      if (server.source.kind === "custom-stdio" && !checks.commandFound(server.source.command)) {
        flags.push(`${server.source.command} isn't found on this machine`);
      }
    }
    items.push({ id: `mcpServer:${server.id}`, part: "mcpServers", kind: "mcpServer", label: server.name, fate, differs, flags });
  }

  const preferenceKeys = Object.keys(read.preferences) as (keyof PreferencesView)[];
  if (preferenceKeys.length > 0) {
    const differs = preferenceKeys.filter((k) => !isDeepStrictEqual(read.preferences[k], local.preferences[k]));
    items.push({
      id: "preferences",
      part: "settings",
      kind: "preferences",
      label: "Preferences",
      fate: differs.length === 0 ? "unchanged" : "differs",
      differs,
      flags: [],
    });
  }

  for (const rule of read.machineCommandRules) {
    const mine = local.machineCommandRules.find((r) => sameRule(r, rule));
    const differs = mine === undefined || mine.verdict === rule.verdict ? [] : [`${mine.verdict} here, ${rule.verdict} in the file`];
    items.push({ id: commandRuleItemId(rule), part: "settings", kind: "commandRule", label: ruleLabel(rule), fate: fateOf(mine, differs), differs, flags: [] });
  }

  // Set against this machine's answer as it holds — its default where it
  // set nothing: a switch is always here, a folder new until added.
  const hereRows = writeScopeRows(local.machineWriteScope, []);
  for (const entry of read.machineWriteScope) {
    const here = hereRows.find((r) => sameWriteLocation(r.location, entry.location))?.machine ?? undefined;
    const word = (on: boolean) => (on ? "on" : "off");
    const differs = here === undefined || here === entry.on ? [] : [`${word(here)} here, ${word(entry.on)} in the file`];
    const { location } = entry;
    items.push({
      id: writeLocationItemId(location),
      part: "settings",
      kind: "writeLocation",
      label: `File writes: ${writeLocationLabel(location)} ${word(entry.on)}`,
      fate: fateOf(here, differs),
      differs,
      flags: here === undefined && location.kind === "path" && !checks.pathExists(location.path) ? ["doesn't exist on this machine"] : [],
    });
  }

  for (const root of read.machineSavedRoots) {
    const here = local.machineSavedRoots.includes(root);
    items.push({
      id: `savedRoot:${root}`,
      part: "settings",
      kind: "savedRoot",
      label: root,
      fate: here ? "unchanged" : "new",
      differs: [],
      flags: here || checks.pathExists(root) ? [] : ["doesn't exist on this machine"],
    });
  }

  return { items, agentIds, serverIds };
}
