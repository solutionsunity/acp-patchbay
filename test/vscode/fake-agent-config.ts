// The config a suite adds — the record a Settings custom Add writes. For the
// fake agent, its script rides in the env (SecretStorage), so every suite
// connects through the product's own path: add, then connect by id, remove
// after.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatchbayAgentId } from "../../src/shared/ids";
import type { AgentConfigView } from "../../src/shared/protocol";
import type { FakeAgentScript } from "../fake-agent/main";

/** Where a fake agent keeps its sessions' records: the suite's window has
 * no folder, and its cwd is the repo — not the agent's to write in. */
function fakeAgentStore(label: string): string {
  return join(tmpdir(), "patchbay-fake-agent", label);
}

/** `label` names the fake agent's records folder; its id is the one the
 * store mints when the config is saved. */
export function fakeAgentConfig(
  label: string,
  name: string,
  fakeAgentPath: string,
  script: FakeAgentScript,
  registry: Pick<AgentConfigView, "origin" | "link"> = { origin: null, link: null },
): AgentConfigView {
  return {
    id: "" as PatchbayAgentId,
    name,
    command: process.execPath,
    args: [fakeAgentPath],
    env: { FAKE_AGENT_SCRIPT: JSON.stringify(script), FAKE_AGENT_STORE: fakeAgentStore(label) },
    autoConnect: false,
    defaults: {},
    ...registry,
    previousVersion: null,
    lastSeenVersion: null,
  };
}
