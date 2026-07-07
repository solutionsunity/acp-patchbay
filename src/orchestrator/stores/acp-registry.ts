// Client for the official ACP agent registry (agentclientprotocol/registry)
// — the roster's identity/install source (roster.ts overlays our own
// adapter-observed knowledge on top: assets/metaExtensions/quirks/
// knownBypassBridge are ours, never upstream's). Cached to disk
// (globalStorageUri — per-machine, never synced) so a cold start or an
// offline CDN still has a roster to show; refreshed at activation and on a
// slow timer. This is a static-data fetch with no agent involved, so the
// "never on a schedule" rule for diagnostic probes (capability-verification.md)
// doesn't apply — that rule is about not spending real agent turns silently,
// not about polling a public manifest.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_FILENAME = "acp-registry-cache.json";
export const REGISTRY_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h — VS Code stays open for days

export const PLATFORM_KEYS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-aarch64",
  "linux-x86_64",
  "windows-aarch64",
  "windows-x86_64",
] as const;
export type PlatformKey = (typeof PLATFORM_KEYS)[number];

const envSchema = z.record(z.string(), z.string()).default({});

const npxOrUvxDistSchema = z.object({
  package: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: envSchema,
});

const binaryTargetSchema = z.object({
  archive: z.string().min(1),
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: envSchema,
});

const distributionSchema = z.object({
  npx: npxOrUvxDistSchema.optional(),
  uvx: npxOrUvxDistSchema.optional(),
  binary: z.record(z.string(), binaryTargetSchema).optional(),
});
export type Distribution = z.infer<typeof distributionSchema>;

export const registryAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  repository: z.string().optional(),
  website: z.string().optional(),
  authors: z.array(z.string()).default([]),
  license: z.string().default(""),
  icon: z.string().optional(),
  distribution: distributionSchema,
});
export type RegistryAgent = z.infer<typeof registryAgentSchema>;

const registryFileSchema = z.object({
  version: z.string(),
  agents: z.array(registryAgentSchema),
});

export interface AcpRegistryData {
  /** "" = never successfully fetched — cold start with no cache and no network. */
  fetchedAt: string;
  agents: readonly RegistryAgent[];
}

const EMPTY: AcpRegistryData = { fetchedAt: "", agents: [] };

const cacheFileSchema = z.object({ fetchedAt: z.string(), agents: z.array(registryAgentSchema) });

export function hostPlatformKey(): PlatformKey | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (os === null || arch === null) return null;
  const key = `${os}-${arch}`;
  return (PLATFORM_KEYS as readonly string[]).includes(key) ? (key as PlatformKey) : null;
}

export type ResolvedDistribution =
  | { kind: "npx"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | { kind: "uvx"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | {
      kind: "binary";
      archiveUrl: string;
      cmd: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
    };

/** npx/uvx first — both are ecosystem-managed installs (npm/PyPI hash-verify
 * their own tarballs, "installing" is just spawning), free and low-risk;
 * binary only when nothing else is offered, since it has no integrity
 * verification of its own (checked against FORMAT.md — no checksum field
 * exists in the spec). */
export function resolveDistribution(
  agent: RegistryAgent,
): ResolvedDistribution | { error: string } {
  const d = agent.distribution;
  if (d.npx) {
    return { kind: "npx", command: "npx", args: ["-y", d.npx.package, ...d.npx.args], env: d.npx.env };
  }
  if (d.uvx) {
    return { kind: "uvx", command: "uvx", args: [d.uvx.package, ...d.uvx.args], env: d.uvx.env };
  }
  if (d.binary) {
    const key = hostPlatformKey();
    if (key === null) return { error: "unsupported platform for a binary distribution" };
    const target = d.binary[key];
    if (target === undefined) return { error: `no binary build published for ${key}` };
    return { kind: "binary", archiveUrl: target.archive, cmd: target.cmd, args: target.args, env: target.env };
  }
  return { error: "this agent publishes no distribution mechanism patchbay understands" };
}

export class AcpRegistryStore {
  private cache: AcpRegistryData = EMPTY;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cacheDir: string,
    private readonly onUpdated: (data: AcpRegistryData) => void,
  ) {}

  /** Loads the on-disk cache (if any) synchronously-shaped for callers, then
   * kicks off a background refresh — callers get *something* immediately
   * (cache or empty) and the real data shortly after via `onUpdated`. */
  async start(): Promise<AcpRegistryData> {
    this.cache = await this.readCacheFile();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REGISTRY_REFRESH_INTERVAL_MS);
    return this.cache;
  }

  current(): AcpRegistryData {
    return this.cache;
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(REGISTRY_URL);
      if (!res.ok) return;
      const parsed = registryFileSchema.safeParse(await res.json());
      if (!parsed.success) return;
      const data: AcpRegistryData = { fetchedAt: new Date().toISOString(), agents: parsed.data.agents };
      this.cache = data;
      await this.writeCacheFile(data);
      this.onUpdated(data);
    } catch {
      // offline or the CDN is unreachable — the existing cache (possibly
      // empty) stands; never surfaced as a user-facing error.
    }
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
  }

  private cacheFilePath(): string {
    return join(this.cacheDir, CACHE_FILENAME);
  }

  private async readCacheFile(): Promise<AcpRegistryData> {
    try {
      const text = await readFile(this.cacheFilePath(), "utf8");
      const parsed = cacheFileSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : EMPTY;
    } catch {
      return EMPTY;
    }
  }

  private async writeCacheFile(data: AcpRegistryData): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.cacheFilePath(), JSON.stringify(data), "utf8");
  }
}
