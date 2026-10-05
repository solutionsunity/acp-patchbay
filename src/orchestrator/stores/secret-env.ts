// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Env-var *values* live in SecretStorage: env is how
// agents and stdio MCP servers commonly take API keys, and the machine store is
// for non-sensitive config only — so config records carry no env at all.
// One JSON record per id, one instance per record family (agents:
// `acpPatchbay.agent.<id>.env`, MCP servers:
// `acpPatchbay.integration.<id>.env` — the same key family the token store
// uses, under the name the values were first stored by). Values are read at
// the moment reality needs them — agent spawn (agents-store.ts connect),
// MCP-server attach (mcp-servers-store.ts mcpServersFor) — and shown back to
// their owner in the Settings forms.
import { z } from "zod";
import type { SecretsLike } from "./mcp-server-tokens";

/** A stored record: names to string values — anything else is malformed. */
const envRecordSchema = z.record(z.string(), z.string());

export class SecretEnvStore {
  constructor(
    private readonly secrets: SecretsLike,
    /** Key-family prefix, e.g. "acpPatchbay.agent". */
    private readonly prefix: string,
    /** Where a malformed stored record is reported — by its id, never its
     * value. */
    private readonly log: (message: string) => void = () => {},
  ) {}

  private key(id: string): string {
    return `${this.prefix}.${id}.env`;
  }

  async get(id: string): Promise<Record<string, string>> {
    const raw = await this.secrets.get(this.key(id));
    if (raw === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const env = envRecordSchema.safeParse(parsed);
    if (env.success) return env.data;
    // Never trusted blind, never gone in silence: reported by its id, since
    // the value is a secret.
    this.log(`the stored env for ${id} is malformed — read as empty`);
    return {};
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
