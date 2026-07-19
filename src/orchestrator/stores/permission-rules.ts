// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Permission rules, two layers. Workspace layer (this file's original
// scope): command rules + file-write scope in workspaceState — per user,
// per workspace, never repo-shipped; a cloned repo must not arrive
// pre-authorized. Machine
// layer (MachineRulesStore): command rules only, in the machine store —
// developer-owned defaults for every workspace ("allow `npm test`
// everywhere"). Evaluation order is workspace first, then machine, then
// ask (broker.ts): a workspace can tighten or loosen its own floor, and
// the repo still can't grant anything — the machine layer never rides it.
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

const MACHINE_KEY = "acpPatchbay.machineCommandRules";

/** Machine-layer command rules — machine store (developer-owned, every
 * workspace on this machine), consulted only after the workspace layer
 * stays silent. Command rules only: file-write scope stays workspace-level
 * by nature (it's defined relative to the current workspace root). */
export class MachineRulesStore {
  constructor(private readonly kv: KV) {}

  get(): { commandRules: CommandRule[] } {
    return { commandRules: this.kv.get<CommandRule[]>(MACHINE_KEY) ?? [] };
  }

  async set(commandRules: CommandRule[]): Promise<void> {
    await this.kv.update(MACHINE_KEY, commandRules);
  }
}
