// The config a suite adds — the record a Settings custom Add writes. For the
// fake agent, its script rides in the env (SecretStorage), so every suite
// connects through the product's own path: add, then connect by id, remove
// after.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a fake agent keeps its sessions' records: the suite's window has
 * no folder, and its cwd is the repo — not the agent's to write in. */
function fakeAgentStore(label: string): string {
  return join(tmpdir(), "patchbay-fake-agent", label);
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  autoConnect: boolean;
  defaults: Record<string, never>;
  registrySource: { registryId: string; distributionKind: "npx"; pinnedVersion: string } | null;
  lastSeenVersion: null;
}

/** `label` names the fake agent's records folder; its id is the one the
 * store mints when the config is saved. */
export function fakeAgentConfig(
  label: string,
  name: string,
  fakeAgentPath: string,
  script: unknown,
  registrySource: AgentConfig["registrySource"] = null,
): AgentConfig {
  return {
    id: "",
    name,
    command: process.execPath,
    args: [fakeAgentPath],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script), FAKE_AGENT_STORE: fakeAgentStore(label) },
    autoConnect: false,
    defaults: {},
    registrySource,
    lastSeenVersion: null,
  };
}
