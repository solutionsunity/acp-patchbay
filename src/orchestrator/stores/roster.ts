// Roster loader: known agents as shipped data, validated at the trust boundary.
// An unmapped assets entry is shown as unmapped — never guessed.
import { z } from "zod";
import rosterJson from "../../../data/roster.json";

const assetLocationsSchema = z.object({
  rules: z.array(z.string()).nullable(),
  commands: z.array(z.string()).nullable(),
  skills: z.array(z.string()).nullable(),
});

export const rosterAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  installHint: z.string(),
  /** null = locations unknown for this agent (honest, not guessed). */
  assets: assetLocationsSchema.nullable(),
  /** Observed _meta extension conventions — adapter knowledge, not spec. */
  metaExtensions: z.array(z.string()),
  /** Earned by observation only — free-text notes beyond the structured fields below. */
  quirks: z.array(z.string()),
  /** A bridge observed to act on fs/terminal regardless of client capabilities
   * — forces the fidelity label to "acts outside" (architecture.md § broker).
   * Defaults false: none observed yet, per the roster's own "earned by
   * observation" rule. */
  knownBypassBridge: z.boolean().default(false),
});

export type RosterAgent = z.infer<typeof rosterAgentSchema>;
export type AssetLocations = z.infer<typeof assetLocationsSchema>;

const rosterSchema = z.object({
  $comment: z.string().optional(),
  agents: z.array(rosterAgentSchema),
});

export function loadRoster(): RosterAgent[] {
  return rosterSchema.parse(rosterJson).agents;
}
