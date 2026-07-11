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
  /** registryId → data URI, fetched host-side at refresh and cached with the
   * registry snapshot. Data URIs on purpose: the authored webview CSP already
   * allows `img-src data:`, so icons render with zero CSP widening and no
   * webview ever talks to the CDN. Version-keyed reuse — an unchanged agent
   * version never refetches; a failed fetch keeps the stale icon (branding,
   * not truth) or stays absent. */
  icons: Readonly<Record<string, string>>;
}

const EMPTY: AcpRegistryData = { fetchedAt: "", agents: [], icons: {} };

/** An icon bigger than this is not an icon — refuse rather than bloat every
 * state snapshot with it. */
const ICON_MAX_BYTES = 128 * 1024;
const ICON_FETCH_TIMEOUT_MS = 10_000;

const cachedIconSchema = z.object({ version: z.string(), dataUri: z.string() });

const cacheFileSchema = z.object({
  fetchedAt: z.string(),
  agents: z.array(registryAgentSchema),
  // default {} keeps pre-icon cache files parsing — icons then refetch.
  icons: z.record(z.string(), cachedIconSchema).default({}),
});

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
  /** Version-keyed icon cache (registryId → {version, dataUri}) — the reuse
   * ledger behind `AcpRegistryData.icons`; persisted in the one cache file. */
  private iconCache: Record<string, { version: string; dataUri: string }> = {};
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
      this.iconCache = await fetchIcons(parsed.data.agents, this.iconCache);
      const data: AcpRegistryData = {
        fetchedAt: new Date().toISOString(),
        agents: parsed.data.agents,
        icons: Object.fromEntries(
          Object.entries(this.iconCache).map(([id, i]) => [id, i.dataUri]),
        ),
      };
      this.cache = data;
      await this.writeCacheFile();
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
      if (!parsed.success) return EMPTY;
      this.iconCache = parsed.data.icons;
      return {
        fetchedAt: parsed.data.fetchedAt,
        agents: parsed.data.agents,
        icons: Object.fromEntries(
          Object.entries(parsed.data.icons).map(([id, i]) => [id, i.dataUri]),
        ),
      };
    } catch {
      return EMPTY;
    }
  }

  private async writeCacheFile(): Promise<void> {
    const file: z.infer<typeof cacheFileSchema> = {
      fetchedAt: this.cache.fetchedAt,
      agents: [...this.cache.agents],
      icons: this.iconCache,
    };
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.cacheFilePath(), JSON.stringify(file), "utf8");
  }
}

/** One icon fetch pass: version-keyed reuse from `prior`, parallel fetches
 * for the rest, honest failure handling (a failed fetch keeps the stale
 * icon — branding, not truth — or stays absent; a non-image content-type or
 * an oversized body is refused). Agents dropped from the registry fall out
 * naturally: only current agents enter the result. Exported for tests. */
export async function fetchIcons(
  agents: readonly RegistryAgent[],
  prior: Record<string, { version: string; dataUri: string }>,
): Promise<Record<string, { version: string; dataUri: string }>> {
  const next: Record<string, { version: string; dataUri: string }> = {};
  await Promise.all(
    agents.map(async (a) => {
      if (a.icon === undefined) return;
      const had = prior[a.id];
      if (had !== undefined && had.version === a.version) {
        next[a.id] = had;
        return;
      }
      try {
        const res = await fetch(a.icon, { signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > ICON_MAX_BYTES) throw new Error("not an icon — too large");
        const declared = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
        const mime = declared.startsWith("image/") ? declared : "image/svg+xml";
        next[a.id] = {
          version: a.version,
          dataUri: `data:${mime};base64,${buf.toString("base64")}`,
        };
      } catch {
        if (had !== undefined) next[a.id] = had;
      }
    }),
  );
  return next;
}
