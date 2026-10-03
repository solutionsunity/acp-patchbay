// The config a suite saves for the fake agent — the record a Settings custom
// Add writes, script in its env (SecretStorage), so every suite connects
// through the product's own path: save, then connect by id, remove after.
export interface FakeAgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  autoConnect: false;
  defaults: Record<string, never>;
  registrySource: { registryId: string; distributionKind: "npx"; pinnedVersion: string } | null;
  lastSeenVersion: null;
}

export interface AgentsDoor {
  save(config: FakeAgentConfig): Promise<void>;
  connect(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  remove(agentId: string): Promise<void>;
}

export function fakeAgentConfig(
  id: string,
  name: string,
  fakeAgentPath: string,
  script: unknown,
  registrySource: FakeAgentConfig["registrySource"] = null,
): FakeAgentConfig {
  return {
    id,
    name,
    command: process.execPath,
    args: [fakeAgentPath],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script) },
    autoConnect: false,
    defaults: {},
    registrySource,
    lastSeenVersion: null,
  };
}
