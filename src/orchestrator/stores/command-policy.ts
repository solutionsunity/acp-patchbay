// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// What stands around the command rules, at each layer: the switch that
// allows every command, and what a command no rule decides gets. The
// machine's is in the machine store, for every workspace; a workspace's in
// its workspaceState — per user, per workspace, never a file of the
// repository: a cloned repo must not arrive with commands running unasked.
// Neither travels in an export either — the choice is made on each machine.
// A stored value this version doesn't take reads as the default: asking.
import { z } from "zod";
import { DEFAULT_COMMAND_POLICY, DEFAULT_COMMAND_POLICY_LAYERS, RULE_VERDICTS, type CommandPolicyLayersView, type CommandPolicyView } from "../../shared/protocol";
import type { KV } from "./kv";
import { STORAGE_KEYS } from "./storage-keys";

const verdict = z.enum(RULE_VERDICTS);
const machineSchema = z.object({ alwaysAllow: z.boolean(), unruled: verdict }) satisfies z.ZodType<CommandPolicyView>;
const workspaceSchema = z.object({ alwaysAllow: z.boolean(), unruled: verdict.nullable() }) satisfies z.ZodType<CommandPolicyLayersView["workspace"]>;

class PolicyStore<P> {
  constructor(
    private readonly kv: KV,
    private readonly key: string,
    private readonly schema: z.ZodType<P>,
    private readonly unset: P,
  ) {}

  get(): P {
    const parsed = this.schema.safeParse(this.kv.get<unknown>(this.key));
    return parsed.success ? parsed.data : this.unset;
  }

  async set(policy: P): Promise<void> {
    await this.kv.update(this.key, policy);
  }

  async wipe(): Promise<void> {
    await this.kv.update(this.key, undefined);
  }
}

export class MachineCommandPolicyStore extends PolicyStore<CommandPolicyView> {
  constructor(kv: KV) {
    super(kv, STORAGE_KEYS.machineCommandPolicy, machineSchema, DEFAULT_COMMAND_POLICY);
  }
}

export class WorkspaceCommandPolicyStore extends PolicyStore<CommandPolicyLayersView["workspace"]> {
  constructor(kv: KV) {
    super(kv, STORAGE_KEYS.commandPolicy, workspaceSchema, DEFAULT_COMMAND_POLICY_LAYERS.workspace);
  }
}
