// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// MCP-server credentials: the one place they're allowed to live
// (secrets never go in settings, never in state stores, never in logs).
// Structural subset of vscode.SecretStorage so this store, like the others,
// is vscode-free and fakeable in tests.
import { z } from "zod";
import type { PatchbayMcpServerId } from "../../shared/ids";
import { SECRET_FAMILIES } from "./storage-keys";

export interface SecretsLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export class MemorySecrets implements SecretsLike {
  private map = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** ISO — absent means the provider reported no expiry. */
  expiresAt?: string;
  /** OAuth refresh context, captured at connect time (the endpoints/client
   * were *discovered* — nothing static to re-derive them from later).
   * Present only for OAuth-connected
   * servers; static-key tokens never expire on our side. */
  tokenEndpoint?: string;
  clientId?: string;
}

/** What every stored token holds; the rest of it is read as stored. */
const storedTokenSchema = z.looseObject({ accessToken: z.string() });

export class McpServerTokenStore {
  constructor(
    private readonly secrets: SecretsLike,
    /** Where a malformed stored token is reported — by its server's id, never
     * its value. */
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Under the name the credentials were first stored by. */
  private key(patchbayMcpServerId: PatchbayMcpServerId): string {
    return `${SECRET_FAMILIES.mcpServer}.${patchbayMcpServerId}.token`;
  }

  async get(patchbayMcpServerId: PatchbayMcpServerId): Promise<StoredToken | null> {
    const raw = await this.secrets.get(this.key(patchbayMcpServerId));
    if (raw === undefined) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    // One bad record costs that record: it reads as no token, and the
    // server's card says it needs signing in.
    if (storedTokenSchema.safeParse(parsed).success) return parsed as StoredToken;
    this.log(`the stored token for ${patchbayMcpServerId} is malformed — read as none`);
    return null;
  }

  async set(patchbayMcpServerId: PatchbayMcpServerId, token: StoredToken): Promise<void> {
    await this.secrets.store(this.key(patchbayMcpServerId), JSON.stringify(token));
  }

  async remove(patchbayMcpServerId: PatchbayMcpServerId): Promise<void> {
    await this.secrets.delete(this.key(patchbayMcpServerId));
  }
}
