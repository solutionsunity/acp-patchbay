// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Client for the official ACP agent registry (agentclientprotocol/registry)
// — THE agent source; patchbay's own per-agent curation lives in code
// tables, meta.ts META_EXTENSIONS being the standing one. Cached to disk (globalStorageUri —
// per-machine, never synced) so a cold start or an offline CDN still has
// agents to show. Read at the moments the registry matters
// (`RegistryReadMoment`), never on a clock — and always right before
// anything acts on what it says: a cheap conditional read, a 304 when
// nothing changed. Between reads the copy is shown with the date it was
// last confirmed; it stands in for the registry only while the registry
// can't answer.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { count } from "../../shared/count";
import type { RegistryAgentView } from "../../shared/protocol";
import { type Logger, nullLogger } from "../logger";
import { describeNetFailure, readBytes, readJson } from "../net";
import { platformOf, registryTarget } from "../platform";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_FILENAME = "acp-registry-cache.json";

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
  // The archive's SHA-256, optional per target. Read as any string: a
  // malformed digest must not hide its agent — the installer judges the
  // format, and refuses to install on a bad one.
  sha256: z.string().optional(),
});

const distributionSchema = z.object({
  npx: npxOrUvxDistSchema.optional(),
  uvx: npxOrUvxDistSchema.optional(),
  binary: z.record(z.string(), binaryTargetSchema).optional(),
});

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

/** What names an entry that can't be read whole. */
const entryIdSchema = registryAgentSchema.pick({ id: true });

/** The file's own shape. Its entries are many vendors' writing, each read
 * on its own by `readRegistry`: one that doesn't fit is one agent gone,
 * never the registry. */
const registryFileSchema = z.object({
  version: z.string(),
  agents: z.array(z.unknown()),
});

interface RegistryReading {
  agents: RegistryAgent[];
  /** One line per entry left out: which, and why. */
  skipped: string[];
}

/** The registry's agents as `raw` lists them, entry by entry; null when
 * `raw` isn't a registry file at all. */
function readRegistry(raw: unknown): RegistryReading | null {
  const file = registryFileSchema.safeParse(raw);
  if (!file.success) return null;
  const reading: RegistryReading = { agents: [], skipped: [] };
  file.data.agents.forEach((entry, i) => {
    const agent = registryAgentSchema.safeParse(entry);
    if (agent.success) {
      reading.agents.push(agent.data);
      return;
    }
    const id = entryIdSchema.safeParse(entry);
    const which = id.success ? `the entry ${JSON.stringify(id.data.id)}` : `entry ${i + 1}`;
    const issue = agent.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
    reading.skipped.push(`skipped ${which} — ${where}${issue?.message ?? "invalid"}`);
  });
  return reading;
}

export interface AcpRegistryData {
  /** "" = never successfully fetched — cold start with no cache and no network. */
  fetchedAt: string;
  agents: readonly RegistryAgent[];
  /** registryId → data URI, fetched host-side at each read and cached with the
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

const cachedIconSchema = z.object({ version: z.string(), dataUri: z.string() });

/** The registry exactly as the CDN served it — never our parse of it — so
 * a build that reads more of the format than the build that fetched it
 * sees everything the registry said (a parse would have dropped what that
 * build didn't know, and an `etag` would then keep the loss forever). A
 * cache in an older shape reads as no cache: one full fetch replaces it. */
const cacheFileSchema = z.object({
  fetchedAt: z.string(),
  etag: z.string().nullable(),
  raw: z.unknown(),
  icons: z.record(z.string(), cachedIconSchema),
});

/** A distribution as the registry publishes it: npx/uvx's package, or the
 * host platform's binary target — the recipe a registry agent is added and
 * upgraded from. */
export type PublishedNpxOrUvx = z.infer<typeof npxOrUvxDistSchema>;
export type PublishedBinaryTarget = z.infer<typeof binaryTargetSchema>;

export type ResolvedDistribution =
  | { kind: "npx" | "uvx"; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; published: PublishedNpxOrUvx }
  | { kind: "binary"; published: PublishedBinaryTarget };

/** The registry record as patchbay presents it (protocol.ts
 * RegistryAgentView): platform launch resolution folded to an honest
 * unavailable reason, plus the code-table curation joined in. */
export function registryAgentView(
  agent: RegistryAgent,
  icons: Readonly<Record<string, string>>,
): RegistryAgentView {
  const resolved = resolveDistribution(agent);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    icon: icons[agent.id] ?? null,
    unavailableReason: "error" in resolved ? resolved.error : null,
    version: agent.version,
  };
}

/** The line an npx/uvx package runs as — spawning it is installing it. */
export function packageLaunch(kind: "npx" | "uvx", published: PublishedNpxOrUvx): { command: string; args: string[] } {
  return kind === "npx"
    ? { command: "npx", args: ["-y", published.package, ...published.args] }
    : { command: "uvx", args: [published.package, ...published.args] };
}

/** npx/uvx first — both are ecosystem-managed installs (npm/PyPI hash-verify
 * their own tarballs, "installing" is just spawning), free and low-risk;
 * binary only when nothing else is offered: patchbay downloads and runs
 * it itself, checked only when its vendor published a digest. */
export function resolveDistribution(
  agent: RegistryAgent,
): ResolvedDistribution | { error: string } {
  const d = agent.distribution;
  if (d.npx) {
    return { kind: "npx", ...packageLaunch("npx", d.npx), env: d.npx.env, published: d.npx };
  }
  if (d.uvx) {
    return { kind: "uvx", ...packageLaunch("uvx", d.uvx), env: d.uvx.env, published: d.uvx };
  }
  if (d.binary) {
    const platform = platformOf();
    if (platform === null) return { error: "unsupported platform for a binary distribution" };
    const key = registryTarget(platform);
    const target = d.binary[key];
    if (target === undefined) return { error: `no binary build published for ${key}` };
    return { kind: "binary", published: target };
  }
  return { error: "this agent publishes no distribution mechanism patchbay understands" };
}

/** The digest a binary download of `version` is checked against — raw, as
 * published. The registry lists only each agent's latest version: while it
 * still lists this one, its current word is the truth (a vendor may
 * re-publish a version with a new digest); once it has moved on, the copy
 * pinned when the version was added or upgraded is all that remains. Null:
 * no digest anywhere. */
export function binaryDigestFor(
  agents: readonly RegistryAgent[],
  registryId: string,
  version: string,
  pinned: string | null,
): string | null {
  const agent = agents.find((a) => a.id === registryId && a.version === version);
  const current = agent === undefined ? undefined : resolveDistribution(agent);
  const listed = current !== undefined && "kind" in current && current.kind === "binary" ? (current.published.sha256 ?? null) : null;
  return listed ?? pinned;
}

/** The moments the registry is read — the one list. A moment is added
 * here, and every site that reads names one. */
export type RegistryReadMoment = "startup" | "new-session" | "settings" | "add" | "upgrade" | "import" | "download" | "manual";

const MOMENT_TEXT: Record<RegistryReadMoment, string> = {
  startup: "startup",
  "new-session": "new session",
  settings: "Settings opened",
  add: "before an add",
  upgrade: "before an upgrade",
  import: "before an import",
  download: "before a download",
  manual: "refresh requested",
};

/** How a read ended: the registry confirmed current (fetched or
 * unchanged), or the reason it couldn't be. */
export type RegistryRead = { ok: true; at: string } | { ok: false; at: string; reason: string };

export class AcpRegistryStore {
  private cache: AcpRegistryData = EMPTY;
  /** The CDN's validator for the cached copy — a read asks "only if
   * changed", so an unchanged registry costs a 304 and no body. */
  private etag: string | null = null;
  private raw: unknown = null;
  /** Version-keyed icon cache (registryId → {version, dataUri}) — the reuse
   * ledger behind `AcpRegistryData.icons`; persisted in the one cache file. */
  private iconCache: Record<string, { version: string; dataUri: string }> = {};
  private inflight: Promise<RegistryRead> | null = null;

  constructor(
    private readonly cacheDir: string,
    /** The registry moved (read and confirmed current) — read it from
     * `current()`; the store is its one holder, so no copy travels. */
    private readonly onUpdated: () => void,
    private readonly log: Logger = nullLogger,
  ) {}

  /** Loads the on-disk cache (if any) — an answer before the first read,
   * held here like every other. Reading is the caller's, at a named moment. */
  async load(): Promise<void> {
    await this.readCacheFile();
  }

  /** What the store holds — the last reading, dated by `fetchedAt`. Never
   * goes to the registry: it answers at once, for what only shows the
   * registry. Whatever acts on it calls `read` first. */
  current(): AcpRegistryData {
    return this.cache;
  }

  /** The one way to the registry: reads it now, at `moment` — the log line
   * names it — and what it held becomes what it answered. Overlapping
   * moments share one read (named by the first). */
  read(moment: RegistryReadMoment): Promise<RegistryRead> {
    this.inflight ??= this.doRead(MOMENT_TEXT[moment]).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRead(moment: string): Promise<RegistryRead> {
    const at = new Date().toISOString();
    const fail = (reason: string): RegistryRead => {
      this.log.warn(
        `ACP registry: read failed (${moment}) — ${reason}; keeping the copy from ${this.cache.fetchedAt || "never"}`,
      );
      return { ok: false, at, reason };
    };
    try {
      const read = await readJson(REGISTRY_URL, { log: this.log, what: "ACP registry", etag: this.etag });
      if (!read.ok) return fail(describeNetFailure(read.failure));
      if (read.value === "unchanged") {
        this.cache = { ...this.cache, fetchedAt: at };
        await this.writeCacheFile();
        this.log.info(`ACP registry: up to date — ${count(this.cache.agents.length, "agent")} (${moment})`);
        this.onUpdated(); // confirmed current: "last checked" moves with it
        return { ok: true, at };
      }
      const reading = readRegistry(read.value.json);
      if (reading === null) return fail("unexpected shape (not a registry file)");
      this.iconCache = await fetchIcons(reading.agents, this.iconCache, this.log);
      this.raw = read.value.json;
      this.etag = read.value.etag;
      this.adopt(reading, at);
      await this.writeCacheFile();
      this.log.info(`ACP registry: fetched — ${count(reading.agents.length, "agent")} (${moment})`);
      this.onUpdated();
      return { ok: true, at };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private cacheFilePath(): string {
    return join(this.cacheDir, CACHE_FILENAME);
  }

  /** A missing, unreadable, or older-shaped cache leaves the store empty —
   * the read that follows fills it. A read that landed while the disk
   * was being read is newer than the disk: the cache never replaces it. */
  private async readCacheFile(): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.cacheFilePath(), "utf8"));
    } catch {
      return; // no cache yet (a first run, storage cleared) or a torn write
    }
    const file = cacheFileSchema.safeParse(json);
    const reading = file.success ? readRegistry(file.data.raw) : null;
    if (!file.success || reading === null) {
      this.log.info("ACP registry: cached copy is in an older shape — fetching it whole");
      return;
    }
    if (this.cache.fetchedAt !== "") return; // a read already landed
    this.raw = file.data.raw;
    this.etag = file.data.etag;
    this.iconCache = file.data.icons;
    this.adopt(reading, file.data.fetchedAt);
  }

  /** `reading` becomes what the store holds — and what it left out is said,
   * once per copy taken. */
  private adopt(reading: RegistryReading, fetchedAt: string): void {
    this.cache = { fetchedAt, agents: reading.agents, icons: iconUris(this.iconCache) };
    for (const line of reading.skipped) this.log.warn(`ACP registry: ${line}`);
  }

  private async writeCacheFile(): Promise<void> {
    const file: z.infer<typeof cacheFileSchema> = {
      fetchedAt: this.cache.fetchedAt,
      etag: this.etag,
      raw: this.raw,
      icons: this.iconCache,
    };
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(this.cacheFilePath(), JSON.stringify(file), "utf8");
  }
}

function iconUris(icons: Record<string, { version: string; dataUri: string }>): Record<string, string> {
  return Object.fromEntries(Object.entries(icons).map(([id, i]) => [id, i.dataUri]));
}

/** One icon fetch pass: version-keyed reuse from `prior`, parallel fetches
 * for the rest, honest failure handling (a failed fetch keeps the stale
 * icon — branding, not truth — or stays absent; a non-image content-type or
 * an oversized body is refused). Agents dropped from the registry fall out
 * naturally: only current agents enter the result. Exported for tests. */
export async function fetchIcons(
  agents: readonly RegistryAgent[],
  prior: Record<string, { version: string; dataUri: string }>,
  log: Logger = nullLogger,
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
      const read = await readBytes(a.icon, { log, what: `icon of ${a.id}`, maxBytes: ICON_MAX_BYTES });
      if (!read.ok) {
        if (had !== undefined) next[a.id] = had; // branding, not truth: stale beats none
        return;
      }
      const declared = read.value.contentType.split(";")[0]?.trim() ?? "";
      const mime = declared.startsWith("image/") ? declared : "image/svg+xml";
      next[a.id] = { version: a.version, dataUri: `data:${mime};base64,${read.value.bytes.toString("base64")}` };
    }),
  );
  return next;
}
