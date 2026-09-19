// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Env-var *values* live in SecretStorage: env is how
// agents and stdio MCP servers commonly take API keys, and the machine store is
// for non-sensitive config only — so config records carry no env at all.
// One JSON record per id, one instance per record family (agents:
// `acpPatchbay.agent.<id>.env`, integrations:
// `acpPatchbay.integration.<id>.env` — the same key family the token store
// uses). Values are read at the moment reality needs them — agent spawn
// (orchestrator.connectAgent), MCP-server attach (integrations.mcpServersFor)
// — and shown back to their owner in the Settings forms.
import type { SecretsLike } from "./integration-tokens";

export class SecretEnvStore {
  constructor(
    private readonly secrets: SecretsLike,
    /** Key-family prefix, e.g. "acpPatchbay.agent". */
    private readonly prefix: string,
  ) {}

  private key(id: string): string {
    return `${this.prefix}.${id}.env`;
  }

  async get(id: string): Promise<Record<string, string>> {
    const raw = await this.secrets.get(this.key(id));
    if (raw === undefined) return {};
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {}; // malformed stored record — dropped rather than trusted blind
    }
  }

  async set(id: string, env: Record<string, string>): Promise<void> {
    if (Object.keys(env).length === 0) {
      await this.secrets.delete(this.key(id));
      return;
    }
    await this.secrets.store(this.key(id), JSON.stringify(env));
  }

  async remove(id: string): Promise<void> {
    await this.secrets.delete(this.key(id));
  }
}
