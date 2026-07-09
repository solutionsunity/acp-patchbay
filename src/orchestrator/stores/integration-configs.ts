// Integrations are developer-env, not code-env: global to this machine,
// same as agent-configs.ts. Deliberately global-only — the MCP incident
// features.md records (a production-access MCP server silently following a
// user between repos) is guarded by credentials never traveling with a
// shared config, not by workspace-scoping the record; binding to
// workspaces (not repos) may return later as an opt-in. SecretStorage
// (integration-tokens.ts) keys credentials globally by integration id.
import { z } from "zod";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

export const integrationSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("registry"),
    registryId: z.string().min(1),
    /** User-supplied endpoint, for registry entries with per-account URLs
     * (Supabase, Augment). Absent when the entry ships a fixed URL. */
    url: z.string().optional(),
    /** Which of the entry's offered mechanisms this connection used —
     * decides how the bridge formats the auth header. */
    authMode: z.enum(["header", "oauth"]).default("header"),
  }),
  z.object({
    kind: z.literal("custom-stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    // No env here on purpose: stdio MCP servers commonly take API keys via
    // env, so values live in SecretStorage (stores/secret-env.ts), read at
    // attach time (integrations.mcpServersFor) — never in globalState.
  }),
  z.object({
    kind: z.literal("custom-http"),
    url: z.string().min(1),
    /** "none" needs no secret; "header" sends the stored key as
     * `{headerName}: {valuePrefix}{key}`; "oauth" runs the MCP-spec OAuth
     * flow against the URL and sends `Authorization: Bearer <token>`. */
    authType: z.enum(["none", "header", "oauth"]).default("none"),
    headerName: z.string().default("Authorization"),
    valuePrefix: z.string().default("Bearer "),
  }),
]);
export type IntegrationSource = z.infer<typeof integrationSourceSchema>;

export const integrationConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: integrationSourceSchema,
  /** "auto" (default) attaches only to agents whose fidelity is fully
   * brokered (features.md § Integrations); an explicit id list pins exactly
   * which agents receive it; `{ except }` is the auto set minus the listed
   * agents — the user's routing, never all-or-nothing. */
  routing: z
    .union([z.literal("auto"), z.array(z.string()), z.object({ except: z.array(z.string()) })])
    .default("auto"),
  /** Inactive = configured with its credential intact, but excluded from
   * every agent's mcpServers — the mute switch, not a disconnect.
   * Disconnect is the full clear (config + credential + env); a curated
   * entry then simply reappears in the catalog, ready for a fresh connect. */
  active: z.boolean().default(true),
});
export type IntegrationConfig = z.infer<typeof integrationConfigSchema>;

const KEY = "acpPatchbay.integrations";

export class IntegrationConfigStore extends GlobalRecordStore<IntegrationConfig> {
  constructor(kv: KV) {
    super(kv, KEY, integrationConfigSchema);
  }
}
