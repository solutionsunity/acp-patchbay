// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Integration credentials: the one place they're allowed to live
// (secrets never go in settings, never in state stores, never in logs).
// Structural subset of vscode.SecretStorage so this store, like the others,
// is vscode-free and fakeable in tests.
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
   * integrations; static-key tokens never expire on our side. */
  tokenEndpoint?: string;
  clientId?: string;
}

export class IntegrationTokenStore {
  constructor(private readonly secrets: SecretsLike) {}

  private key(integrationId: string): string {
    return `acpPatchbay.integration.${integrationId}.token`;
  }

  async get(integrationId: string): Promise<StoredToken | null> {
    const raw = await this.secrets.get(this.key(integrationId));
    if (raw === undefined) return null;
    return JSON.parse(raw) as StoredToken;
  }

  async set(integrationId: string, token: StoredToken): Promise<void> {
    await this.secrets.store(this.key(integrationId), JSON.stringify(token));
  }

  async remove(integrationId: string): Promise<void> {
    await this.secrets.delete(this.key(integrationId));
  }
}
