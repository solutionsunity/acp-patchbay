// Registry loader: curated integrations as shipped data (architecture.md §
// Integrations — "the registry is shipped data from day one... adding a
// curated integration in v2 is a data change, not code"). Same trust-boundary
// treatment as roster.ts: validated with zod, never trusted blind.
//
// Auth model per docs/reference-mcp-oauth.md (decided): every entry offers
// up to two mechanisms — a static key sent in a configurable header (the v1
// floor), and/or MCP-spec OAuth 2.1 with open Dynamic Client Registration
// (the upgrade, URL-only — everything else is discovered on the wire).
// No per-service OAuth Apps, no Device Flow, no pre-provisioned client ids.
import { z } from "zod";
import registryJson from "../../../data/registry.json";

export const registryHeaderAuthSchema = z.object({
  /** HTTP header carrying the key — "Authorization" for most, but e.g.
   * Stitch needs "X-Goog-Api-Key" (the case that forces this field). */
  headerName: z.string().default("Authorization"),
  /** Prepended to the stored key when building the header value —
   * "Bearer " for Authorization-style, "" for raw-key headers. */
  valuePrefix: z.string().default("Bearer "),
  /** Where the user gets a key — shown next to the paste field. */
  hint: z.string().default(""),
  /** The page that issues the key — rendered as a clickable "get a key"
   * link, not buried in hint prose. */
  keyUrl: z.string().default(""),
});

export const registryAuthSchema = z.object({
  /** null = this service has no static-key mode (Figma remote). */
  header: registryHeaderAuthSchema.nullable(),
  /** True only where DCR is verified genuinely open — an allowlisted DCR
   * (Figma) is false: attempting it would just 403. */
  oauth: z.boolean().default(false),
});

export const registryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Remote MCP endpoint. "" when `userUrl` — per-account/per-project
   * services (Supabase, Augment) have no fixed public URL to ship. */
  url: z.string(),
  /** The user supplies their own endpoint at connect time. */
  userUrl: z.boolean().default(false),
  /** Vendor's own setup docs — the honest pointer when something here
   * needs a step on their side (keys, GitHub App installs, allowlists). */
  docsUrl: z.string(),
  /** Shown on the card. Carries per-entry honesty (Figma's gated DCR,
   * Augment's GitHub App prerequisite) — never buried. */
  note: z.string().default(""),
  auth: registryAuthSchema,
  /** Verified official *local* server for this vendor, when one exists —
   * offered as a prefill into the custom add form, never auto-run. Two
   * shapes: a stdio command (github-mcp-server, @stripe/mcp — `envKeys`
   * names the vars the user must fill) or a local HTTP endpoint served by
   * the vendor's own desktop app (Figma's Dev Mode server). */
  local: z
    .union([
      z.object({
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        envKeys: z.array(z.string()).default([]),
        note: z.string().default(""),
      }),
      z.object({
        url: z.string().min(1),
        note: z.string().default(""),
      }),
    ])
    .nullable()
    .default(null),
});

export type RegistryHeaderAuth = z.infer<typeof registryHeaderAuthSchema>;
export type RegistryAuth = z.infer<typeof registryAuthSchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

const registrySchema = z.object({
  $comment: z.string().optional(),
  integrations: z.array(registryEntrySchema),
});

export function loadRegistry(): RegistryEntry[] {
  return registrySchema.parse(registryJson).integrations;
}

/** Connectable = an endpoint can exist (fixed or user-supplied) and at
 * least one auth mechanism is actually open to us. Figma remote fails the
 * second clause today (no key mode, DCR allowlisted) — shown, not hidden. */
export function isConnectable(entry: RegistryEntry): boolean {
  const hasEndpoint = entry.url !== "" || entry.userUrl;
  const hasAuth = entry.auth.header !== null || entry.auth.oauth;
  return hasEndpoint && hasAuth;
}
