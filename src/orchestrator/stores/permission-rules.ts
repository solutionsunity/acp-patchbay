// Permission rules: command allowlists + file-write scope. Placement:
// workspaceState + built-in defaults — per user, per workspace, never
// repo-shipped; a cloned repo must not arrive pre-authorized
// (architecture.md § State, § Permission broker).
import type { KV } from "./kv";

export type RuleVerdict = "allow" | "ask" | "deny";

export interface CommandRule {
  pattern: string; // glob-ish command pattern, e.g. "npm run *"
  verdict: RuleVerdict;
}

export type FileWriteScope = "workspace" | "workspace+temp" | "always-ask";

export interface PermissionRules {
  commandRules: CommandRule[];
  fileWriteScope: FileWriteScope;
}

/** Sane defaults: nothing pre-allowed — everything asks. */
export const DEFAULT_PERMISSION_RULES: PermissionRules = {
  commandRules: [],
  fileWriteScope: "workspace",
};

const KEY = "acpPatchbay.permissionRules";

export class PermissionRulesStore {
  constructor(private readonly kv: KV) {}

  get(): PermissionRules {
    const stored = this.kv.get<Partial<PermissionRules>>(KEY);
    return {
      commandRules: stored?.commandRules ?? DEFAULT_PERMISSION_RULES.commandRules,
      fileWriteScope:
        stored?.fileWriteScope ?? DEFAULT_PERMISSION_RULES.fileWriteScope,
    };
  }

  async set(rules: PermissionRules): Promise<void> {
    await this.kv.update(KEY, rules);
  }
}
