// Registry loader: curated integrations as shipped data (architecture.md §
// Integrations — "the registry is shipped data from day one... adding a
// curated integration in v2 is a data change, not code"). Same trust-boundary
// treatment as roster.ts: validated with zod, never trusted blind.
import { z } from "zod";
import registryJson from "../../../data/registry.json";

export const registryAuthSchema = z.object({
  type: z.literal("oauth-device"),
  scopes: z.array(z.string()),
  deviceCodeUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  /** Empty until the OAuth App exists — connecting is a no-op until filled. */
  clientId: z.string(),
});

export const registryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.literal("http"),
  /** Empty until the registry entry's app/endpoint is finalized (see clientId). */
  url: z.string(),
  auth: registryAuthSchema,
});

export type RegistryAuth = z.infer<typeof registryAuthSchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

const registrySchema = z.object({
  $comment: z.string().optional(),
  integrations: z.array(registryEntrySchema),
});

export function loadRegistry(): RegistryEntry[] {
  return registrySchema.parse(registryJson).integrations;
}

/** A registry entry is connectable once its owner-supplied fields are filled
 * in — never before, since an empty clientId/url can't reach anything real. */
export function isConnectable(entry: RegistryEntry): boolean {
  return entry.url !== "" && entry.auth.clientId !== "";
}
