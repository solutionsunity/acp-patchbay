// Roster = the official ACP agent registry (agentclientprotocol/registry,
// via acp-registry.ts) plus our own adapter-observed overlay (assets/
// metaExtensions/quirks/knownBypassBridge — data the registry doesn't and
// shouldn't carry). An overlay entry with no `registryId` is local-only
// (the registry doesn't list it) and carries its own launch command exactly
// like the pre-registry roster did. Trust-boundary treatment for the overlay
// file is unchanged from before: shipped data, validated with zod, never
// trusted blind.
import { z } from "zod";
import rosterOverlayJson from "../../../data/roster-overlay.json";
import { resolveDistribution, type RegistryAgent } from "./acp-registry";

const assetLocationsSchema = z.object({
  rules: z.array(z.string()).nullable(),
  commands: z.array(z.string()).nullable(),
  skills: z.array(z.string()).nullable(),
});
export type AssetLocations = z.infer<typeof assetLocationsSchema>;

const localLaunchSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  installHint: z.string(),
});

const overlayAgentSchema = z.object({
  id: z.string().min(1),
  registryId: z.string().min(1).optional(),
  /** Present only when `registryId` is absent — a local-only entry. */
  local: localLaunchSchema.optional(),
  assets: assetLocationsSchema.nullable(),
  metaExtensions: z.array(z.string()),
  quirks: z.array(z.string()),
  knownBypassBridge: z.boolean().default(false),
});
export type OverlayAgent = z.infer<typeof overlayAgentSchema>;

const overlaySchema = z.object({
  $comment: z.string().optional(),
  agents: z.array(overlayAgentSchema),
});

export function loadOverlay(): OverlayAgent[] {
  return overlaySchema.parse(rosterOverlayJson).agents;
}

export type RosterLaunch =
  | { kind: "local"; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | {
      kind: "npx" | "uvx";
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      registryId: string;
      version: string;
    }
  | {
      kind: "binary";
      archiveUrl: string;
      cmd: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      registryId: string;
      version: string;
    }
  /** Listed (by the registry or locally) but not addable right now — no
   * usable distribution for this platform, or the overlay references a
   * registry id the registry hasn't (yet) returned. Shown, never guessed. */
  | { kind: "unavailable"; reason: string; registryId: string | null; version: string | null };

export interface RosterAgent {
  id: string;
  name: string;
  /** Registry description, or the local entry's installHint. */
  description: string;
  assets: AssetLocations | null;
  metaExtensions: readonly string[];
  quirks: readonly string[];
  knownBypassBridge: boolean;
  launch: RosterLaunch;
}

/** Registry-driven: every registry agent gets a roster entry (using our own
 * overlay id where we've curated one, so existing configs/sessions keep
 * their id — the registry's own id otherwise). Local-only overlay entries
 * (no `registryId`) are appended after. */
export function mergeRoster(
  overlay: readonly OverlayAgent[],
  registryAgents: readonly RegistryAgent[],
): RosterAgent[] {
  const overlayByRegistryId = new Map(
    overlay.filter((o): o is OverlayAgent & { registryId: string } => o.registryId !== undefined).map((o) => [o.registryId, o]),
  );
  const seenRegistryIds = new Set<string>();
  const out: RosterAgent[] = [];
  for (const reg of registryAgents) {
    seenRegistryIds.add(reg.id);
    const o = overlayByRegistryId.get(reg.id);
    const resolved = resolveDistribution(reg);
    const launch: RosterLaunch =
      "error" in resolved
        ? { kind: "unavailable", reason: resolved.error, registryId: reg.id, version: reg.version }
        : { ...resolved, registryId: reg.id, version: reg.version };
    out.push({
      id: o?.id ?? reg.id,
      name: reg.name,
      description: reg.description,
      assets: o?.assets ?? null,
      metaExtensions: o?.metaExtensions ?? [],
      quirks: o?.quirks ?? [],
      knownBypassBridge: o?.knownBypassBridge ?? false,
      launch,
    });
  }
  // A curated overlay entry whose registryId isn't in this snapshot (cold
  // start before the first fetch resolves, or the registry temporarily
  // dropped it) still gets a roster row — honestly unavailable, never
  // silently missing.
  for (const o of overlay) {
    if (o.registryId === undefined || seenRegistryIds.has(o.registryId)) continue;
    out.push({
      id: o.id,
      name: o.id,
      description: "",
      assets: o.assets,
      metaExtensions: o.metaExtensions,
      quirks: o.quirks,
      knownBypassBridge: o.knownBypassBridge,
      launch: {
        kind: "unavailable",
        reason: registryAgents.length === 0 ? "registry not loaded yet" : "not found in the current registry snapshot",
        registryId: o.registryId,
        version: null,
      },
    });
  }
  for (const o of overlay) {
    if (o.registryId !== undefined || o.local === undefined) continue;
    out.push({
      id: o.id,
      name: o.local.name,
      description: o.local.installHint,
      assets: o.assets,
      metaExtensions: o.metaExtensions,
      quirks: o.quirks,
      knownBypassBridge: o.knownBypassBridge,
      launch: { kind: "local", command: o.local.command, args: o.local.args, env: o.local.env },
    });
  }
  return out;
}
