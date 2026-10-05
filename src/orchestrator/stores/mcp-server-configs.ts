// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// MCP servers are developer-env, not code-env: global to this machine,
// same as agent-configs.ts. Deliberately global-only — the MCP incident
// (a production-access MCP server silently following a user between repos)
// is guarded by configs never riding a repo: a credential moves only by
// its owner's explicit Copy and paste, never by opening a folder. Binding
// to workspaces (not repos) may return later as an opt-in. SecretStorage
// (mcp-server-tokens.ts) keys credentials globally by server id.
import { z } from "zod";
import { GlobalRecordStore } from "./global-record-store";
import type { KV } from "./kv";

export const mcpServerSourceSchema = z.discriminatedUnion("kind", [
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
    // attach time (mcp-servers-store.ts mcpServersFor) — never in the machine store.
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
export type McpServerSource = z.infer<typeof mcpServerSourceSchema>;

export const mcpServerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: mcpServerSourceSchema,
  /** "auto" (default) attaches to every agent (the fidelity gate is
   * superseded — protocol.ts McpServerRoutingView records why); an
   * explicit id list pins exactly which agents receive it; `{ except }` is
   * every agent minus the listed — the user's routing, never
   * all-or-nothing. */
  routing: z
    .union([z.literal("auto"), z.array(z.string()), z.object({ except: z.array(z.string()) })])
    .default("auto"),
  /** Inactive = configured with its credential intact, but excluded from
   * every agent's mcpServers — the mute switch, not a disconnect.
   * Disconnect is the full clear (config + credential + env); a curated
   * entry then simply reappears in the catalog, ready for a fresh connect. */
  active: z.boolean().default(true),
  /** How an http-backed server reaches agents that declare mcp.http:
   * "auto" passes the URL through and the agent's own MCP client connects
   * (prompt.image mechanics — the declared path gets exercised); "bridge"
   * pins patchbay's stdio bridge regardless — the user's escape hatch for
   * an agent whose declared http support turns out broken. Agents without
   * the declaration always ride the bridge; custom-stdio ignores this. */
  transport: z.enum(["auto", "bridge"]).default("auto"),
});
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

/** Under the name the records were first stored by. */
const KEY = "acpPatchbay.integrations";

export class McpServerConfigStore extends GlobalRecordStore<McpServerConfig> {
  constructor(kv: KV) {
    super(kv, KEY, mcpServerConfigSchema);
  }
}
