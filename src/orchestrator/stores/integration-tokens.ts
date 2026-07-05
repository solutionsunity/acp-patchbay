// Integration credentials: the one place they're allowed to live
// (architecture.md § State — "Secrets... never settings, never state stores,
// never logs"; no-secret-exposure.md). Structural subset of
// vscode.SecretStorage so this store, like the others, is vscode-free and
// fakeable in tests.
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
