// Tracks which repo-defined agents (from .vscode/acp-patchbay.json) the user
// has explicitly adopted. Separate from PermissionRulesStore: adoption is a
// one-time trust decision per agent, not a rule that governs ongoing
// behavior — different shape, different lifecycle, its own store
// (architecture.md § Permission broker: "first connect of a workspace-defined
// agent requires one-time explicit adoption").
import type { KV } from "./kv";

const KEY = "acpPatchbay.adoptedWorkspaceAgents";

export class WorkspaceAgentAdoptionStore {
  constructor(private readonly kv: KV) {}

  isAdopted(agentId: string): boolean {
    return (this.kv.get<string[]>(KEY) ?? []).includes(agentId);
  }

  async adopt(agentId: string): Promise<void> {
    const current = this.kv.get<string[]>(KEY) ?? [];
    if (current.includes(agentId)) return;
    await this.kv.update(KEY, [...current, agentId]);
  }
}
