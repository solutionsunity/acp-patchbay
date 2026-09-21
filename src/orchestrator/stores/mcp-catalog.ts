// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Solutions Unity

// Curated MCP server catalog — shipped data (adding a curated server is a
// data change, not code), loaded through zod like every other trust
// boundary: validated, never trusted blind. Every fact in an entry is the
// vendor's public documentation, not a patchbay finding: the catalog lists
// what the vendor publishes, and a wrong fact surfaces as an issue.
//
// Auth model (decided): every entry offers up to two mechanisms — a static
// key sent in a configurable header (the floor), and/or MCP-spec OAuth 2.1
// with open Dynamic Client Registration (the upgrade, URL-only — everything
// else is discovered on the wire). No per-service OAuth Apps, no Device
// Flow, no pre-provisioned client ids.
import { z } from "zod";
import catalogJson from "../../../data/mcp-catalog.json";

const catalogHeaderAuthSchema = z.object({
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

const catalogAuthSchema = z.object({
  /** null = this service has no static-key mode (Figma remote). */
  header: catalogHeaderAuthSchema.nullable(),
  /** OAuth as the vendor documents it. Set false where a failure was
   * reproduced — Figma's allowlisted DCR 403s, so offering it would only
   * fail. */
  oauth: z.boolean().default(false),
});

const catalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** What the server is for, one line — the row shows it and the catalog
   * search matches it. Required: an entry nobody can describe isn't
   * curated. `note` below is a different thing — per-entry caveats. */
  description: z.string().min(1),
  /** The vendor's mark — the curated-only exception to the Codicons rule
   * (recorded decision, 2026-07-12): monochrome SVG path data, rendered
   * with fill=currentColor so color follows text exactly like a codicon,
   * no CSP change (inline SVG needs none). Not in the data file: every
   * entry has data/icons/<id>.svg (one path, one viewBox, provenance in
   * the file's leading comment) and the build folds it in — an entry
   * without art doesn't build, so there is no fallback to render. */
  brandIcon: z.object({ viewBox: z.string(), path: z.string() }),
  /** Remote MCP endpoint. "" when `userUrl` — per-account/per-project
   * services (Supabase, Augment) have no fixed public URL to ship. */
  url: z.string(),
  /** The user supplies their own endpoint at connect time. */
  userUrl: z.boolean().default(false),
  /** Vendor's own setup docs — the source every other field is read from,
   * and the honest pointer when something needs a step on their side
   * (keys, GitHub App installs, allowlists). */
  docsUrl: z.string(),
  /** Shown on the card. Carries per-entry caveats (Figma's gated DCR,
   * Augment's GitHub App prerequisite) — never buried. */
  note: z.string().default(""),
  auth: catalogAuthSchema,
  /** The vendor's official *local* server, when it documents one —
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

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

const catalogSchema = z.object({
  $comment: z.string().optional(),
  servers: z.array(catalogEntrySchema),
});

export function loadCatalog(): CatalogEntry[] {
  return catalogSchema.parse(catalogJson).servers;
}

/** Connectable = an endpoint can exist (fixed or user-supplied) and at
 * least one auth mechanism is actually open to us. Figma remote fails the
 * second clause today (no key mode, DCR allowlisted) — shown, not hidden. */
export function isConnectable(entry: CatalogEntry): boolean {
  const hasEndpoint = entry.url !== "" || entry.userUrl;
  const hasAuth = entry.auth.header !== null || entry.auth.oauth;
  return hasEndpoint && hasAuth;
}
