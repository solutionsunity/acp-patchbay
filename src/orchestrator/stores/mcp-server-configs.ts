// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// MCP servers are developer-env, not code-env: their records are global to
// this machine, same as agent-configs.ts, and visible in every window — but
// each is on only in the workspaces it is scoped to. The MCP incident (a
// production-access server silently following a user between repos) is
// guarded twice: configs never ride a repo — a credential moves only by its
// owner's explicit Copy and paste, never by opening a folder — and a new
// server is on only where it was added. SecretStorage (mcp-server-tokens.ts)
// keys credentials globally by server id.
import { z } from "zod";
import { addedMcpServerName, mcpServerName } from "../../shared/names";
import { NamedRecordStore } from "./global-record-store";
import type { KV } from "./kv";
import type { PatchbayAgentId, PatchbayMcpServerId } from "../../shared/ids";
import { forget } from "../../shared/reach";
import type { WorkspaceId } from "../../shared/workspace";
import { reachSchema } from "./reach-schema";
import { savedId } from "./saved-id";
import { STORAGE_KEYS } from "./storage-keys";

export const mcpServerSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("catalog"),
    catalogId: z.string().min(1),
    /** User-supplied endpoint, for catalog entries with per-account URLs
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

/** How a server authenticates: a curated entry by the mechanism its
 * connect used, a custom http server by its own setting; a stdio server
 * takes no credential of patchbay's. */
export function authTypeOf(source: McpServerSource): "none" | "header" | "oauth" {
  if (source.kind === "catalog") return source.authMode;
  if (source.kind === "custom-http") return source.authType;
  return "none";
}

export const mcpServerConfigSchema = z.object({
  id: savedId<PatchbayMcpServerId>(),
  name: z.string().min(1),
  source: mcpServerSourceSchema,
  /** "auto" (default) attaches to every agent (the fidelity gate is
   * superseded — protocol.ts McpServerRoutingView records why); an
   * explicit id list pins exactly which agents receive it; `{ except }` is
   * every agent minus the listed — the user's routing, never
   * all-or-nothing. */
  routing: reachSchema<PatchbayAgentId>().default("auto"),
  /** The workspaces the server is on in — every one, these, or every one
   * but these — beside which agents it reaches; a session gets it only
   * where both say so. Off in a workspace = configured with its credential
   * intact, given to no session there. Disconnect is the full clear
   * (config + credential + env); a curated entry then simply reappears in
   * the catalog, ready for a fresh connect. */
  workspaces: reachSchema<WorkspaceId>(),
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
const KEY = STORAGE_KEYS.mcpServers;

/** A server's name is the key it goes to agents under: cut to what agents
 * keep, never the built-in editor server's, and never two of one. */
export class McpServerConfigStore extends NamedRecordStore<McpServerConfig> {
  constructor(kv: KV) {
    // Once, before anything reads the records: the servers as an earlier
    // version kept them are copied, never moved — a window still on that
    // version keeps its own key — so every migration below runs on the
    // copy. Each was switched on or off for every workspace: on becomes
    // every workspace, off none.
    const earlier = kv.get<unknown>(STORAGE_KEYS.mcpServersBefore090);
    if (kv.get<unknown>(KEY) === undefined && Array.isArray(earlier)) {
      void kv.update(
        KEY,
        earlier.map((r: unknown) => {
          if (typeof r !== "object" || r === null) return r;
          const { active, ...rest } = r as { active?: unknown };
          return { ...rest, workspaces: active === false ? [] : "auto" };
        }),
      );
    }
    super(kv, KEY, mcpServerConfigSchema);
    this.machine = kv;
    // Once, at construction: a server connected from the catalog before the
    // catalog was named so is stored as `{ kind: "registry", registryId }` —
    // rewritten as `{ kind: "catalog", catalogId }`, every other field as
    // stored. Read as it was, the record would fail its schema and be dropped.
    const stored = kv.get<unknown>(KEY);
    const fromRegistry = (r: unknown): r is { source: { kind: "registry"; registryId: unknown } } =>
      typeof r === "object" &&
      r !== null &&
      "source" in r &&
      typeof r.source === "object" &&
      r.source !== null &&
      "kind" in r.source &&
      r.source.kind === "registry";
    if (Array.isArray(stored) && stored.some(fromRegistry)) {
      void kv.update(
        KEY,
        stored.map((r: unknown) => {
          if (!fromRegistry(r)) return r;
          const { kind: _kind, registryId, ...rest } = r.source;
          return { ...r, source: { ...rest, kind: "catalog", catalogId: registryId } };
        }),
      );
    }
  }

  private readonly machine: KV;

  /** Every record goes — the earlier version's copy with them. */
  override async wipe(): Promise<void> {
    await super.wipe();
    await this.machine.update(STORAGE_KEYS.mcpServersBefore090, undefined);
  }

  /** Throws for a name that cuts to nothing — refused by every add, and
   * asked first by a connect that stores a credential before its add. */
  static admitName(name: string): void {
    if (mcpServerName(name) === "") throw new Error("the name is empty");
  }

  override async add(value: McpServerConfig): Promise<string> {
    McpServerConfigStore.admitName(value.name);
    return super.add(value);
  }

  protected override freeName(name: string, taken: readonly string[]): string {
    return addedMcpServerName(name, taken);
  }

  /** A removed agent leaves every reach list that names it, in one write —
   * an "only" list it alone was on then reaches no one, as chosen. */
  async forgetAgent(patchbayAgentId: PatchbayAgentId): Promise<void> {
    await this.rewrite((current) => current.map((v) => ({ ...v, routing: forget(v.routing, patchbayAgentId) })));
  }
}
